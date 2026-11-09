import { describe, expect, test } from "bun:test"
import { SqliteAdapter } from "../../src/reliability/sqlite.js"
import { AgentRegistry } from "../../src/agents/registry.js"
import { ModelRouter } from "../../src/agents/router.js"
import { RunManager } from "../../src/application/run-manager.js"
import { Orchestrator } from "../../src/orchestration/orchestrator.js"
import type { TaskExecutor, TaskExecutionContext } from "../../src/orchestration/orchestrator.js"

async function setup(executor: TaskExecutor) {
  const db = await SqliteAdapter.open()
  const reg = new AgentRegistry()
  const router = new ModelRouter()
  router.setAvailable([{ providerID: "opencode", modelID: "iceman-free", costInputPerMTok: 0, supportsTools: true }])
  const rm = new RunManager(db, reg)
  const orch = new Orchestrator({ runManager: rm, persistence: db, registry: reg, router, executor, now: () => Date.now() })
  return { db, reg, rm, orch, router }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("Orchestrator — supervised approvals (R4, FR-102)", () => {
  test("pending → WAITING_APPROVAL; approve → task completes (same attempt)", async () => {
    const exec: TaskExecutor = async (ctx: TaskExecutionContext) => ({
      ok: true,
      evidence: [{ kind: "log", ref: ctx.task.id, summary: "done" }],
    })
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({
      goal: "g",
      mode: "supervised",
      tasks: [
        { type: "exploration", title: "explore" },
        { type: "implementation", title: "impl", dependencies: ["#0"], acceptanceCriteria: [{ id: "AC-1", statement: "x", evidenceRequired: true }] },
      ],
    })

    const runPromise = orch.run(run.id)
    // Wait for the impl task to park in WAITING_APPROVAL.
    let parked = false
    for (let i = 0; i < 100 && !parked; i++) {
      await sleep(50)
      const tasks = await rm.getTasks(run.id)
      const impl = tasks.find((t) => t.title === "impl")!
      if (impl.status === "WAITING_APPROVAL") parked = true
    }
    expect(parked).toBe(true)

    // Confirm an approval record was created.
    const approvals = await db.listApprovalsByRun(run.id)
    expect(approvals.length).toBe(1)
    expect(approvals[0]!.status).toBe("pending")

    // Approve → task should resume + complete on the SAME attempt (no attempts increment).
    const n = await orch.decideApproval(run.id, "approved", "human")
    expect(n).toBe(1)
    const outcome = await runPromise
    expect(outcome).toBe("succeeded")

    const tasks = await rm.getTasks(run.id)
    const impl = tasks.find((t) => t.title === "impl")!
    expect(impl.status).toBe("SUCCEEDED")
    expect(impl.attempts).toBe(1)
    await db.close()
  })

  test("reject → FAILED and dependents SKIPPED", async () => {
    const exec: TaskExecutor = async (ctx: TaskExecutionContext) => ({
      ok: true,
      evidence: [{ kind: "log", ref: ctx.task.id, summary: "done" }],
    })
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({
      goal: "g",
      mode: "supervised",
      tasks: [
        { type: "exploration", title: "explore" },
        { type: "implementation", title: "impl", dependencies: ["#0"] },
        { type: "test", title: "test", dependencies: ["#1"] },
      ],
    })

    const runPromise = orch.run(run.id)
    let parked = false
    for (let i = 0; i < 100 && !parked; i++) {
      await sleep(50)
      const tasks = await rm.getTasks(run.id)
      const impl = tasks.find((t) => t.title === "impl")!
      if (impl.status === "WAITING_APPROVAL") parked = true
    }
    expect(parked).toBe(true)

    await orch.decideApproval(run.id, "rejected", "human")
    const outcome = await runPromise
    expect(outcome).toBe("failed")

    const tasks = await rm.getTasks(run.id)
    const impl = tasks.find((t) => t.title === "impl")!
    const test = tasks.find((t) => t.title === "test")!
    expect(impl.status).toBe("FAILED")
    expect(test.status).toBe("SKIPPED")
    await db.close()
  })

  test("expired approval auto-fails the parked task", async () => {
    // Use a controllable clock.
    let now = 1000
    const db = await SqliteAdapter.open()
    const reg = new AgentRegistry()
    const router = new ModelRouter()
    router.setAvailable([{ providerID: "opencode", modelID: "iceman-free", costInputPerMTok: 0, supportsTools: true }])
    const rm = new RunManager(db, reg)
    const orch = new Orchestrator({ runManager: rm, persistence: db, registry: reg, router, executor: async () => ({ ok: true, evidence: [{ kind: "log", ref: "x", summary: "d" }] }), now: () => now })
    const run = await rm.createRun({
      goal: "g",
      mode: "supervised",
      budget: { maxTotalSeconds: 86400, maxConcurrentWorkers: 4, maxAttemptsPerTask: 3 },
      tasks: [
        { type: "exploration", title: "explore" },
        { type: "implementation", title: "impl", dependencies: ["#0"] },
      ],
    })

    const runPromise = orch.run(run.id)
    let parked = false
    for (let i = 0; i < 100 && !parked; i++) {
      await sleep(10)
      const tasks = await rm.getTasks(run.id)
      const impl = tasks.find((t) => t.title === "impl")!
      if (impl.status === "WAITING_APPROVAL") parked = true
    }
    expect(parked).toBe(true)

    // Expire all pending approvals by advancing the clock past their 8h expiry.
    now += 9 * 60 * 60 * 1000
    const outcome = await runPromise
    expect(outcome).toBe("failed")
    const tasks = await rm.getTasks(run.id)
    const impl = tasks.find((t) => t.title === "impl")!
    expect(impl.status).toBe("FAILED")
    await db.close()
  })
})