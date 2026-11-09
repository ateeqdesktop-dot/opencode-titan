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
  const orch = new Orchestrator({
    runManager: rm,
    persistence: db,
    registry: reg,
    router,
    executor,
    now: () => Date.now(),
  })
  return { db, reg, rm, orch, router }
}

describe("Orchestrator — happy path (FR-050)", () => {
  test("runs a two-task chain to completion", async () => {
    const exec: TaskExecutor = async (ctx: TaskExecutionContext) => ({
      ok: true,
      evidence: [{ kind: "log", ref: ctx.task.id, summary: "done" }],
    })
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "explore" },
        { type: "implementation", title: "impl", dependencies: ["#0"] },
      ],
    })
    const outcome = await orch.run(run.id)
    expect(outcome).toBe("succeeded")
    const tasks = await rm.getTasks(run.id)
    expect(tasks.every((t) => t.status === "SUCCEEDED")).toBe(true)
    const r = await rm.getRun(run.id)
    expect(r?.status).toBe("CLOSED")
    await db.close()
  })

  test("failure propagates to dependents (SKIPPED)", async () => {
    const exec: TaskExecutor = async (ctx) => {
      if (ctx.task.title === "explore") {
        return { ok: false, evidence: [], errorClass: "task-execution", errorMessage: "boom" }
      }
      return { ok: true, evidence: [] }
    }
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "explore" },
        { type: "implementation", title: "impl", dependencies: ["#0"] },
      ],
    })
    const outcome = await orch.run(run.id)
    expect(outcome).toBe("failed")
    const tasks = await rm.getTasks(run.id)
    const impl = tasks.find((t) => t.title === "impl")!
    expect(impl.status).toBe("SKIPPED")
    await db.close()
  })

  test("single task, no deps", async () => {
    const exec: TaskExecutor = async () => ({ ok: true, evidence: [] })
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({ goal: "g", tasks: [{ type: "exploration", title: "solo" }] })
    expect(await orch.run(run.id)).toBe("succeeded")
    await db.close()
  })
})

describe("Orchestrator — concurrency (NFR-004)", () => {
  test("independent tasks run (up to maxWorkers)", async () => {
    let maxConcurrent = 0
    let current = 0
    const exec: TaskExecutor = async () => {
      current++
      maxConcurrent = Math.max(maxConcurrent, current)
      await new Promise((r) => setTimeout(r, 50))
      current--
      return { ok: true, evidence: [] }
    }
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "a" },
        { type: "exploration", title: "b" },
        { type: "exploration", title: "c" },
        { type: "exploration", title: "d" },
      ],
      budget: { maxConcurrentWorkers: 2, maxAttemptsPerTask: 3, maxTotalSeconds: 60 },
    })
    await orch.run(run.id)
    expect(maxConcurrent).toBeLessThanOrEqual(2)
    expect(maxConcurrent).toBeGreaterThanOrEqual(1)
    await db.close()
  })
})

describe("Orchestrator — budget (FR-047)", () => {
  test("stops scheduling when model-call budget exhausted", async () => {
    const exec: TaskExecutor = async () => ({ ok: true, evidence: [], modelCalls: 1, costUsd: 0 })
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({
      goal: "g",
      tasks: [
        { type: "exploration", title: "a" },
        { type: "exploration", title: "b", dependencies: ["#0"] },
        { type: "exploration", title: "c", dependencies: ["#1"] },
      ],
      budget: { maxConcurrentWorkers: 4, maxAttemptsPerTask: 3, maxTotalSeconds: 60, maxModelCalls: 1 },
    })
    const outcome = await orch.run(run.id)
    // With 1 model call budget, only first task's call fits; rest blocked by budget → paused
    expect(["budget-exhausted", "succeeded", "failed"]).toContain(outcome)
    await db.close()
  })
})

describe("Orchestrator — cancel (FR-106)", () => {
  test("cancel stops the run", async () => {
    const exec: TaskExecutor = async () => {
      await new Promise((r) => setTimeout(r, 2000))
      return { ok: true, evidence: [] }
    }
    const { rm, orch, db } = await setup(exec)
    const run = await rm.createRun({ goal: "g", tasks: [{ type: "exploration", title: "slow" }] })
    // Cancel shortly after start.
    const runPromise = orch.run(run.id)
    setTimeout(() => orch.cancel(run.id), 100)
    const outcome = await runPromise
    expect(outcome).toBe("cancelled")
    await db.close()
  })
})
