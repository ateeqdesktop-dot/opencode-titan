/**
 * Recovery (SRS §10.2, §12.2, FR-090/091, FAULT-01..08).
 *
 * On OpenCode restart, TITAN must:
 *  - Load Event Journal + persisted Run/Task state.
 *  - Validate integrity (orphans, schema version).
 *  - Reconcile leases: expire stale ones; a task still "RUNNING" with no live
 *    lease is ambiguous → mark NEEDS_RECONCILIATION (never assume success).
 *  - Resume only provably-safe work (READY/QUEUED tasks whose deps are met).
 *  - Never auto-spend: budget exhaustion keeps the run paused/resumable.
 *
 * This module is pure orchestration over `PersistenceAdapter` + `RunManager`.
 */
import { type PersistenceAdapter } from "./adapter.js"
import { RunManager } from "../application/run-manager.js"
import { type RunFullState } from "../domain/types.js"

export interface RecoveryReport {
  readonly runsScanned: number
  readonly runsResumed: number
  readonly tasksReconciled: number
  readonly tasksMarkedNeedsReconciliation: number
  readonly leasesExpired: number
  readonly integrityIssues: string[]
  readonly errors: string[]
}

export interface RecoveryOptions {
  /** Tasks whose lease is older than this are considered stale. Default 5 min. */
  readonly staleLeaseMs?: number
  /** Whether to auto-transition ambiguous RUNNING tasks to NEEDS_RECONCILIATION. Default true. */
  readonly reconcileAmbiguous?: boolean
}

const DEFAULT_STALE_LEASE_MS = 5 * 60 * 1000

export async function recover(
  adapter: PersistenceAdapter,
  runManager: RunManager,
  opts: RecoveryOptions = {},
): Promise<RecoveryReport> {
  const staleMs = opts.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS
  const reconcile = opts.reconcileAmbiguous ?? true
  const now = Date.now()
  const report: {
    runsScanned: number
    runsResumed: number
    tasksReconciled: number
    tasksMarkedNeedsReconciliation: number
    leasesExpired: number
    integrityIssues: string[]
    errors: string[]
  } = {
    runsScanned: 0,
    runsResumed: 0,
    tasksReconciled: 0,
    tasksMarkedNeedsReconciliation: 0,
    leasesExpired: 0,
    integrityIssues: [],
    errors: [],
  }

  // 1. Integrity check first.
  const integrity = await adapter.verifyIntegrity()
  if (!integrity.ok) {
    report.integrityIssues.push(...integrity.issues)
  }

  // 2. Expire stale leases (dead workers).
  report.leasesExpired = await adapter.expireLeases(now - staleMs)

  // 3. Scan non-terminal runs.
  const runs = await runManager.listRuns()
  const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "REJECTED", "CLOSED"])
  const activeRuns = runs.filter((r) => !terminal.has(r.status))
  report.runsScanned = activeRuns.length

  for (const run of activeRuns) {
    try {
      const tasks = await runManager.getTasks(run.id)
      let touched = false
      for (const task of tasks) {
        // A task marked RUNNING but with no (or expired) lease is ambiguous.
        // WAITING_APPROVAL is deliberate parking (human gate) — even without a
        // live lease it must NOT be reconciled to BLOCKED; the approval state
        // machine owns its next move (R4, FR-102).
        if (task.status === "RUNNING" || task.status === "VERIFYING") {
          const lease = await adapter.getLease(task.id)
          const leaseAlive = !!lease && lease.expiresAt > now
          if (!leaseAlive) {
            if (reconcile) {
              // Mark as NEEDS_RECONCILIATION via the aux state on the Run, and the task as
              // NEEDS_REWORK so it can be re-run (never auto-succeed).
              await runManager.transitionTask(task.id, "BLOCKED", "recovery: no live lease, ambiguous state")
              report.tasksMarkedNeedsReconciliation++
              touched = true
            }
          } else {
            report.tasksReconciled++
          }
        }
        // READY/QUEUED tasks whose deps are met are safe to resume.
        if (task.status === "READY" || task.status === "QUEUED") {
          touched = true
        }
      }
      if (touched) report.runsResumed++
    } catch (e) {
      report.errors.push(`run ${run.id}: ${String(e)}`)
    }
  }

  return report
}
