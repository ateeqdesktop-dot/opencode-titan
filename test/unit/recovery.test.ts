import { describe, expect, test } from "bun:test"
import { SqliteAdapter } from "../../src/reliability/sqlite.js"
import { AgentRegistry } from "../../src/agents/registry.js"
import { RunManager } from "../../src/application/run-manager.js"
import { recover } from "../../src/reliability/recovery.js"

async function setup() {
  const db = await SqliteAdapter.open()
  const reg = new AgentRegistry()
  const mgr = new RunManager(db, reg)
  return { db, reg, mgr }
}

describe("recovery (SRS §10.2, FAULT)", () => {
  test("clean DB: no runs, no issues", async () => {
    const { db, mgr } = await setup()
    const r = await recover(db, mgr)
    expect(r.runsScanned).toBe(0)
    expect(r.integrityIssues).toHaveLength(0)
    expect(r.errors).toHaveLength(0)
    await db.close()
  })

  test("integrity failure (orphan task) is reported", async () => {
    const { db, mgr } = await setup()
    // inject an orphan task directly
    await db.putTask({
      id: "ORPHAN",
      runId: "MISSING",
      type: "test",
      title: "orphan",
      status: "READY",
      priority: "LOW",
      dependencies: "[]",
      inputArtifactIds: "[]",
      acceptanceCriteria: "[]",
      limits: "{}",
      idempotencyKey: "k",
      attempts: 0,
      evidence: "[]",
      createdAt: 1,
      updatedAt: 1,
    })
    const r = await recover(db, mgr)
    expect(r.integrityIssues.some((i) => i.includes("orphan"))).toBe(true)
    await db.close()
  })

  test("stale lease is expired", async () => {
    const { db, mgr } = await setup()
    const run = await mgr.createRun({ goal: "g", tasks: [{ type: "implementation", title: "t" }] })
    const tasks = await mgr.getTasks(run.id)
    const tid = tasks[0]!.id
    // acquire an already-expired lease
    await db.acquireLease(tid, "dead-worker", -1)
    const r = await recover(db, mgr, { staleLeaseMs: 1 })
    expect(r.leasesExpired).toBeGreaterThanOrEqual(1)
    await db.close()
  })

  test("RUNNING task with no live lease → BLOCKED (never auto-succeed)", async () => {
    const { db, mgr } = await setup()
    const run = await mgr.createRun({ goal: "g", tasks: [{ type: "implementation", title: "t" }] })
    const tasks = await mgr.getTasks(run.id)
    const tid = tasks[0]!.id
    await mgr.transitionTask(tid, "READY")
    await mgr.transitionTask(tid, "QUEUED")
    await mgr.transitionTask(tid, "RUNNING")
    // no lease acquired → ambiguous
    const r = await recover(db, mgr)
    expect(r.tasksMarkedNeedsReconciliation).toBe(1)
    const after = await mgr.getTask(tid)
    expect(after?.status).toBe("BLOCKED")
    await db.close()
  })

  test("terminal runs are not scanned", async () => {
    const { db, mgr } = await setup()
    const run = await mgr.createRun({ goal: "g" })
    await mgr.transitionRun(run.id, "PREFLIGHT")
    await mgr.transitionRun(run.id, "FAILED")
    await mgr.transitionRun(run.id, "CLOSED")
    const r = await recover(db, mgr)
    expect(r.runsScanned).toBe(0)
    await db.close()
  })

  test("active run with READY task counts as resumed", async () => {
    const { db, mgr } = await setup()
    const run = await mgr.createRun({ goal: "g", tasks: [{ type: "exploration", title: "t" }] })
    const tasks = await mgr.getTasks(run.id)
    await mgr.transitionTask(tasks[0]!.id, "READY")
    const r = await recover(db, mgr)
    expect(r.runsScanned).toBe(1)
    expect(r.runsResumed).toBe(1)
    await db.close()
  })
})
