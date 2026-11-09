/**
 * Orchestrator (SRS §5.2, §7.2, §7.3, FR-050..FR-056, FR-060..FR-074).
 *
 * Drives a Run to completion:
 *  - schedules ready tasks up to maxWorkers concurrency (FR-050, NFR-004)
 *  - acquires leases before starting a task (FR-054)
 *  - assigns a role per task type, routes a model (FR-030/040)
 *  - isolates writes in a worktree when policy requires (FR-060)
 *  - executes via an injected `TaskExecutor` (real impl uses OpenCode sessions)
 *  - propagates failure to dependents (DAG)
 *  - honours pause/cancel/budget limits
 *  - emits progress events via the journal
 *
 * The orchestrator never blocks setup; it is driven by `run()` which returns
 * a promise the caller may await (command/RPC) or fire-and-forget.
 */
import { RunManager } from "../application/run-manager.js"
import { type PersistenceAdapter } from "../reliability/adapter.js"
import { BudgetManager } from "../platform/budget.js"
import { ModelRouter, type RouteDecision } from "../agents/router.js"
import { AgentRegistry } from "../agents/registry.js"
import { Dag } from "./dag.js"
import { transitionRun, transitionTask } from "../domain/state.js"
import { type Run, type Task, type TaskState, type RunFullState } from "../domain/types.js"
import { isRetryable } from "../domain/types.js"

// ── Executor abstraction (real impl binds OpenCode sessions) ──────────────────
export interface TaskExecutionContext {
  readonly run: Run
  readonly task: Task
  readonly role: string
  readonly model: RouteDecision
  readonly workspaceDir?: string
  readonly signal: AbortSignal
}

export interface TaskExecutionResult {
  readonly ok: boolean
  readonly evidence: { kind: "diff" | "test" | "log" | "artifact" | "command"; ref: string; summary: string; ok?: boolean }[]
  readonly errorClass?: string
  readonly errorMessage?: string
  readonly costUsd?: number
  readonly modelCalls?: number
}

export type TaskExecutor = (ctx: TaskExecutionContext) => Promise<TaskExecutionResult>

export interface OrchestratorDeps {
  readonly runManager: RunManager
  readonly persistence: PersistenceAdapter
  readonly registry: AgentRegistry
  readonly router: ModelRouter
  readonly executor: TaskExecutor
  readonly worktreeForTask?: (task: Task) => Promise<string | undefined>
  readonly now?: () => number
}

export type RunOutcome = "succeeded" | "failed" | "cancelled" | "paused" | "budget-exhausted"

export interface RunProgress {
  readonly runId: string
  readonly status: RunFullState
  readonly tasks: { id: string; title: string; status: TaskState }[]
  readonly percent: number
  readonly activeWorkers: number
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps
  private readonly now: () => number
  private abortControllers = new Map<string, AbortController>()
  private paused = new Set<string>()
  private cancelled = new Set<string>()

  constructor(deps: OrchestratorDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
  }

  /** Drive a run to completion. Resolves with the final outcome. */
  async run(runId: string): Promise<RunOutcome> {
    const rm = this.deps.runManager
    const run = await rm.getRun(runId)
    if (!run) throw new Error(`Run not found: ${runId}`)

    // Move CREATED/PREFLIGHT → RUNNING as needed.
    if (run.status === "CREATED") await rm.transitionRun(runId, "PREFLIGHT", "orchestrator start")
    if ((await rm.getRun(runId))!.status === "PREFLIGHT")
      await rm.transitionRun(runId, "ANALYZING", "analysis")
    const r2 = (await rm.getRun(runId))!
    if (r2.status === "ANALYZING") await rm.transitionRun(runId, "PLANNING", "planning")
    const r3 = (await rm.getRun(runId))!
    if (r3.status === "PLANNING") await rm.transitionRun(runId, "READY", "plan ready")
    const r4 = (await rm.getRun(runId))!
    if (r4.status === "READY" || r4.status === "AWAITING_APPROVAL") {
      await rm.transitionRun(runId, "RUNNING", "execution started")
    }

    const budget = new BudgetManager(run.budget, this.now())
    const maxWorkers = budget.maxWorkers

    // Main scheduling loop.
    while (true) {
      if (this.cancelled.has(runId)) {
        await rm.transitionRun(runId, "CANCELLED", "user cancelled").catch(() => {})
        return "cancelled"
      }
      if (this.paused.has(runId)) {
        await rm.transitionRun(runId, "PAUSED", "user paused").catch(() => {})
        // Wait until resumed or cancelled.
        await this.waitWhilePaused(runId)
        if (this.cancelled.has(runId)) {
          await rm.transitionRun(runId, "CANCELLED", "cancelled while paused").catch(() => {})
          return "cancelled"
        }
        await rm.transitionRun(runId, "RUNNING", "resumed").catch(() => {})
      }

      const currentRun = (await rm.getRun(runId))!
      if (currentRun.status !== "RUNNING") {
        // Terminal or unknown — stop.
        return this.outcomeFromStatus(currentRun.status)
      }

      // Budget gate (FR-047).
      const stop = budget.shouldStopScheduling(this.now())
      if (stop.stop) {
        await rm.transitionRun(runId, "PAUSED", stop.reason).catch(() => {})
        return "budget-exhausted"
      }

      const tasks = await rm.getTasks(runId)
      const running = tasks.filter((t) => t.status === "RUNNING" || t.status === "VERIFYING" || t.status === "WAITING_APPROVAL")
      const slots = maxWorkers - running.length
      if (slots <= 0) {
        // Wait for a worker to finish.
        await this.sleep(50)
        continue
      }

      const ready = await rm.readyTasks(runId)
      // Exclude tasks already running/queued-attempted.
      const candidates = ready.filter((t) => t.status === "READY" || t.status === "QUEUED" || t.status === "DRAFT")
      if (candidates.length === 0) {
        if (running.length > 0) {
          await this.sleep(50)
          continue
        }
        break
      }

      // Launch up to `slots` tasks concurrently.
      const batch = candidates.slice(0, slots)
      await Promise.all(batch.map((t) => this.startTask(runId, t.id, budget, maxWorkers)))
    }

    // All tasks done — determine run outcome.
    const finalTasks = await rm.getTasks(runId)
    const anyFailed = finalTasks.some((t) => t.status === "FAILED")
    const allSucceeded = finalTasks.every((t) => t.status === "SUCCEEDED" || t.status === "SKIPPED" || t.status === "CANCELLED")
    if (anyFailed && !allSucceeded) {
      await rm.transitionRun(runId, "FAILED", "one or more tasks failed").catch(() => {})
      return "failed"
    }
    await rm.transitionRun(runId, "VERIFYING", "all tasks done").catch(() => {})
    await rm.transitionRun(runId, "SUCCEEDED", "run complete").catch(() => {})
    await rm.transitionRun(runId, "CLOSED", "closed").catch(() => {})
    return "succeeded"
  }

  private async startTask(runId: string, taskId: string, budget: BudgetManager, maxWorkers: number): Promise<void> {
    const rm = this.deps.runManager
    const task = await rm.getTask(taskId)
    if (!task) return
    const run = await rm.getRun(runId)
    if (!run) return

    // Budget: attempts.
    if (!budget.canAttempt(task.attempts)) {
      await rm.transitionTask(taskId, "FAILED", "max attempts exceeded").catch(() => {})
      return
    }

    // Lease.
    const owner = `worker-${taskId}-${this.now()}`
    const acquired = await rm.acquireTaskLease(taskId, owner, 5 * 60 * 1000)
    if (!acquired) return // someone else owns it

    // Assign role + model.
    const roleId = rm.selectRoleForTask(task)
    await rm.assignRole(taskId, roleId).catch(() => {})
    const role = this.deps.registry.get(roleId)
    const model = this.deps.router.route({
      taskType: task.type,
      requiresTools: role.allowedTools.length > 0,
      preferred: role.preferredModel ? [`${role.preferredModel}`] : [],
      allowlist: [],
      allowFallback: role.fallbackModels.length > 0,
    })
    // Attach preferred model from role if present in available models.
    if (role.preferredModel) {
      const avail = this.deps.router.getAvailable()
      const hit = avail.find((m) => `${m.providerID}/${m.modelID}` === role.preferredModel)
      if (hit) {
        // Re-route with pin to honor role preference.
        try {
          const pinned = this.deps.router.route({
            taskType: task.type,
            requiresTools: role.allowedTools.length > 0,
            pinnedModel: role.preferredModel,
            allowlist: [],
            allowFallback: role.fallbackModels.length > 0,
          })
          Object.assign(model, pinned)
        } catch {
          // keep cheapest
        }
      }
    }

    // Worktree.
    let workspaceDir: string | undefined
    if (role.workspacePolicy === "isolated-write" && this.deps.worktreeForTask) {
      workspaceDir = await this.deps.worktreeForTask(task).catch(() => undefined)
    }

    // Transition to RUNNING.
    const cur = await rm.getTask(taskId)
    if (cur && (cur.status === "DRAFT" || cur.status === "BLOCKED")) {
      await rm.transitionTask(taskId, "READY").catch(() => {})
    }
    await rm.transitionTask(taskId, "QUEUED").catch(() => {})
    await rm.transitionTask(taskId, "RUNNING").catch(() => {})
    const t = await rm.getTask(taskId)
    if (t) {
      t.attempts = (t.attempts ?? 0) + 1
      if (workspaceDir) t.workspaceId = workspaceDir
      await rm.updateTask(t)
    }
    // Attempt budget check (after RUNNING so FAILED transition is legal).
    const freshT = await rm.getTask(taskId)
    if (freshT && !budget.canAttempt(freshT.attempts - 1)) {
      await rm.transitionTask(taskId, "FAILED", "max attempts exceeded").catch(() => {})
      await rm.releaseTaskLease(taskId, owner).catch(() => {})
      this.abortControllers.delete(taskId)
      return
    }

    // Execute.
    const ac = new AbortController()
    this.abortControllers.set(taskId, ac)
    let result: TaskExecutionResult
    try {
      budget.assertCanSpend(0, this.now())
      result = await Promise.race([
        this.deps.executor({
          run: run,
          task: (await rm.getTask(taskId))!,
          role: roleId,
          model,
          ...(workspaceDir !== undefined ? { workspaceDir } : {}),
          signal: ac.signal,
        }),
        new Promise<TaskExecutionResult>((resolve) => {
          if (ac.signal.aborted) {
            resolve({ ok: false, evidence: [], errorClass: "cancelled", errorMessage: "aborted" })
            return
          }
          ac.signal.addEventListener(
            "abort",
            () => resolve({ ok: false, evidence: [], errorClass: "cancelled", errorMessage: "aborted" }),
            { once: true },
          )
        }),
      ])
    } catch (e) {
      result = {
        ok: false,
        evidence: [],
        errorClass: "task-execution",
        errorMessage: String(e),
      }
    } finally {
      this.abortControllers.delete(taskId)
    }

    // Record budget usage.
    if (result.modelCalls) budget.recordModelCall(result.costUsd ?? 0)
    if (result.costUsd) budget.recordActualCost(result.costUsd)

    // Release lease.
    await rm.releaseTaskLease(taskId, owner).catch(() => {})

    // Persist result + transition.
    const updated = await rm.getTask(taskId)
    if (updated) {
      updated.evidence = [...updated.evidence, ...result.evidence.map((e) => ({ ...e, at: this.now() }))]
      await rm.updateTask(updated)
    }

    if (result.ok) {
      await rm.transitionTask(taskId, "VERIFYING").catch(() => {})
      await rm.transitionTask(taskId, "SUCCEEDED").catch(() => {})
    } else {
      // Failure propagation policy: dependents of a failed task are SKIPPED so
      // the DAG can never start them on stale upstream results (FR-026/027).
      const dag = await rm.dagForRun(runId)
      dag.setState(taskId, "failed")
      const skipped = dag.propagateFailure(taskId)
      for (const sid of skipped) {
        await rm.transitionTask(sid, "SKIPPED", `upstream ${taskId} failed`).catch(() => {})
      }
      const cls = (result.errorClass ?? "task-execution") as string
      await rm.transitionTask(taskId, "FAILED", result.errorMessage).catch(() => {})
      // If retryable and attempts remain, route back through rework → QUEUED.
      const post = await rm.getTask(taskId)
      if (post && isRetryable(cls as never) && post.attempts < post.limits.maxAttempts) {
        await rm.transitionTask(taskId, "NEEDS_REWORK", "retryable failure, re-queue").catch(() => {})
        await rm.transitionTask(taskId, "QUEUED").catch(() => {})
      }
    }

    // Journal progress.
    await this.deps.persistence.appendEvent({
      type: "task.finished",
      runId,
      taskId,
      schemaVersion: 1,
      payload: JSON.stringify({ ok: result.ok, errorClass: result.errorClass }),
      at: this.now(),
    })
  }

  pause(runId: string): void {
    this.paused.add(runId)
  }

  resume(runId: string): void {
    this.paused.delete(runId)
  }

  cancel(runId: string): void {
    this.cancelled.add(runId)
    // Abort any in-flight workers for this run's tasks (best-effort; tasks tracked separately).
    for (const [tid, ac] of this.abortControllers) {
      // We don't have run→task index here; abort all is acceptable for cancel-all semantics.
      ac.abort()
    }
  }

  private async waitWhilePaused(runId: string): Promise<void> {
    while (this.paused.has(runId) && !this.cancelled.has(runId)) {
      await this.sleep(100)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  private outcomeFromStatus(s: RunFullState): RunOutcome {
    if (s === "SUCCEEDED" || s === "CLOSED") return "succeeded"
    if (s === "CANCELLED") return "cancelled"
    if (s === "PAUSED") return "paused"
    return "failed"
  }
}
