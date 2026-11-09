import { describe, expect, test } from "bun:test"
import { SqliteAdapter } from "../../src/reliability/sqlite.js"
import { AgentRegistry } from "../../src/agents/registry.js"
import { RunManager } from "../../src/application/run-manager.js"
import { transitionRun, transitionTask } from "../../src/domain/state.js"

async function fresh() {
  const db = await SqliteAdapter.open()
  const reg = new AgentRegistry()
  const mgr = new RunManager(db, reg)
  return { db, reg, mgr }
}

describe("RunManager — createRun (FR-008, FR-023)", () => {
  test("creates a run with default budget (4 workers)", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({ goal: "build X" })
    expect(run.goal).toBe("build X")
    expect(run.status).toBe("CREATED")
    expect(run.mode).toBe("direct")
    expect(run.budget.maxConcurrentWorkers).toBe(4)
    expect(run.id).toMatch(/^RUN-/)
  })

  test("persists the run (survives re-read)", async () => {
    const { db, mgr } = await fresh()
    const run = await mgr.createRun({ goal: "g" })
    const got = await mgr.getRun(run.id)
    expect(got?.goal).toBe("g")
    expect(got?.id).toBe(run.id)
    await db.close()
  })

  test("creates tasks with dependency indices resolved", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "explore" },
        { type: "implementation", title: "impl", dependencies: ["#0"] },
        { type: "test", title: "test", dependencies: ["#1"] },
      ],
    })
    const tasks = await mgr.getTasks(run.id)
    expect(tasks).toHaveLength(3)
    expect(tasks[1]!.dependencies).toEqual([tasks[0]!.id])
    expect(tasks[2]!.dependencies).toEqual([tasks[1]!.id])
    // idempotency keys present
    expect(tasks[0]!.idempotencyKey).toContain(run.id)
  })

  test("rejects an invalid DAG (cycle) before persisting", async () => {
    const { mgr, db } = await fresh()
    await expect(
      mgr.createRun({
        goal: "g",
        tasks: [
          { type: "implementation", title: "a", dependencies: ["#1"] },
          { type: "implementation", title: "b", dependencies: ["#0"] },
        ],
      }),
    ).rejects.toThrow(/Invalid task graph/)
    // Nothing persisted
    expect(await db.listRuns()).toHaveLength(0)
    await db.close()
  })

  test("rejects missing-dependency reference", async () => {
    const { mgr } = await fresh()
    await expect(
      mgr.createRun({
        goal: "g",
        tasks: [{ type: "implementation", title: "a", dependencies: ["#5"] }],
      }),
    ).rejects.toThrow(/Invalid task graph/)
  })

  test("budget + mode overrides", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      mode: "supervised",
      budget: { maxConcurrentWorkers: 8, maxAttemptsPerTask: 5, maxTotalSeconds: 100 },
    })
    expect(run.mode).toBe("supervised")
    expect(run.budget.maxConcurrentWorkers).toBe(8)
    expect(run.budget.maxAttemptsPerTask).toBe(5)
  })

  test("auto-selects role by task type when assignedRole omitted", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [{ type: "review", title: "review it" }],
    })
    const tasks = await mgr.getTasks(run.id)
    // Not auto-assigned yet (manager doesn't auto-assign; caller does). Role selection helper works.
    const role = mgr.selectRoleForTask(tasks[0]!)
    expect(role).toBe("reviewer")
  })
})

describe("RunManager — state transitions (FR-008/009)", () => {
  test("legal Run transition persists + journals", async () => {
    const { mgr, db } = await fresh()
    const run = await mgr.createRun({ goal: "g" })
    const next = await mgr.transitionRun(run.id, "PREFLIGHT")
    expect(next.status).toBe("PREFLIGHT")
    const persisted = await db.getRun(run.id)
    expect(persisted?.status).toBe("PREFLIGHT")
    const events = await db.listEvents({ runId: run.id })
    expect(events.some((e) => e.type === "run.transition")).toBe(true)
    await db.close()
  })

  test("illegal Run transition throws and does NOT persist", async () => {
    const { mgr, db } = await fresh()
    const run = await mgr.createRun({ goal: "g" })
    await expect(mgr.transitionRun(run.id, "SUCCEEDED")).rejects.toThrow()
    const persisted = await db.getRun(run.id)
    expect(persisted?.status).toBe("CREATED")
    await db.close()
  })

  test("FAILED never jumps to SUCCEEDED via manager", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({ goal: "g" })
    await mgr.transitionRun(run.id, "PREFLIGHT")
    await mgr.transitionRun(run.id, "FAILED")
    await expect(mgr.transitionRun(run.id, "SUCCEEDED")).rejects.toThrow()
  })

  test("Task transition persists + journals; evidence captures reason", async () => {
    const { mgr, db } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [{ type: "implementation", title: "impl" }],
    })
    const tasks = await mgr.getTasks(run.id)
    const tid = tasks[0]!.id
    // DRAFT -> READY -> QUEUED -> RUNNING
    await mgr.transitionTask(tid, "READY")
    await mgr.transitionTask(tid, "QUEUED")
    const t = await mgr.transitionTask(tid, "RUNNING", "worker started")
    expect(t.status).toBe("RUNNING")
    expect(t.evidence.some((e) => e.summary === "worker started")).toBe(true)
    const events = await db.listEvents({ runId: run.id })
    expect(events.some((e) => e.type === "task.transition")).toBe(true)
    await db.close()
  })

  test("illegal Task transition throws", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [{ type: "implementation", title: "impl" }],
    })
    const tasks = await mgr.getTasks(run.id)
    const tid = tasks[0]!.id
    await mgr.transitionTask(tid, "READY")
    await mgr.transitionTask(tid, "QUEUED")
    await mgr.transitionTask(tid, "RUNNING")
    await mgr.transitionTask(tid, "VERIFYING")
    await mgr.transitionTask(tid, "SUCCEEDED")
    // SUCCEEDED is terminal
    await expect(mgr.transitionTask(tid, "RUNNING")).rejects.toThrow()
  })
})

describe("RunManager — readiness (FR-050, FR-025)", () => {
  test("readyTasks returns root task first, then dependents after success", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "a" },
        { type: "implementation", title: "b", dependencies: ["#0"] },
      ],
    })
    const tasks = await mgr.getTasks(run.id)
    // Mark both DRAFT -> READY
    for (const t of tasks) await mgr.transitionTask(t.id, "READY")
    const ready1 = await mgr.readyTasks(run.id)
    expect(ready1.map((t) => t.title)).toEqual(["a"])
    // complete a
    await mgr.transitionTask(tasks[0]!.id, "QUEUED")
    await mgr.transitionTask(tasks[0]!.id, "RUNNING")
    await mgr.transitionTask(tasks[0]!.id, "VERIFYING")
    await mgr.transitionTask(tasks[0]!.id, "SUCCEEDED")
    const ready2 = await mgr.readyTasks(run.id)
    expect(ready2.map((t) => t.title)).toEqual(["b"])
  })
})

describe("RunManager — role assignment", () => {
  test("assignRole persists and validates suitability", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [{ type: "review", title: "review" }],
    })
    const tasks = await mgr.getTasks(run.id)
    const tid = tasks[0]!.id
    const updated = await mgr.assignRole(tid, "reviewer")
    expect(updated.assignedRole).toBe("reviewer")
    // unsuitable role rejected
    await expect(mgr.assignRole(tid, "implementer")).rejects.toThrow(/not suitable/)
    // unknown role rejected
    await expect(mgr.assignRole(tid, "ghost")).rejects.toThrow()
  })
})

describe("RunManager — leases (FR-054)", () => {
  test("acquire/release task lease", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({ goal: "g", tasks: [{ type: "implementation", title: "t" }] })
    const tasks = await mgr.getTasks(run.id)
    const tid = tasks[0]!.id
    expect(await mgr.acquireTaskLease(tid, "worker-1", 60_000)).toBe(true)
    expect(await mgr.acquireTaskLease(tid, "worker-2", 60_000)).toBe(false)
    await mgr.releaseTaskLease(tid, "worker-1")
    expect(await mgr.acquireTaskLease(tid, "worker-2", 60_000)).toBe(true)
  })
})

describe("RunManager — progress", () => {
  test("reports counts and percent", async () => {
    const { mgr } = await fresh()
    const run = await mgr.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "a" },
        { type: "implementation", title: "b", dependencies: ["#0"] },
      ],
    })
    const tasks = await mgr.getTasks(run.id)
    const p0 = await mgr.progress(run.id)
    expect(p0.dag.total).toBe(2)
    expect(p0.dag.percent).toBe(0)
    // complete a
    await mgr.transitionTask(tasks[0]!.id, "READY")
    await mgr.transitionTask(tasks[0]!.id, "QUEUED")
    await mgr.transitionTask(tasks[0]!.id, "RUNNING")
    await mgr.transitionTask(tasks[0]!.id, "VERIFYING")
    await mgr.transitionTask(tasks[0]!.id, "SUCCEEDED")
    const p1 = await mgr.progress(run.id)
    expect(p1.dag.succeeded).toBe(1)
    expect(p1.dag.percent).toBe(50)
  })
})

describe("RunManager — list/filter", () => {
  test("listRunsByStatus filters", async () => {
    const { mgr } = await fresh()
    const r1 = await mgr.createRun({ goal: "a" })
    const r2 = await mgr.createRun({ goal: "b" })
    await mgr.transitionRun(r2.id, "PREFLIGHT")
    const created = await mgr.listRunsByStatus(["CREATED"])
    expect(created.map((r) => r.id)).toContain(r1.id)
    expect(created.map((r) => r.id)).not.toContain(r2.id)
  })
})
