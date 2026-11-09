import { describe, expect, test } from "bun:test"
import {
  deniedToolsForRole,
  roleSystemText,
  taskPromptText,
  classifySessionError,
  extractAssistant,
  summarizeOutcome,
} from "../../src/execution/session-executor.js"
import { AgentRegistry, BUILTIN_ROLES } from "../../src/agents/registry.js"
import { runBlueprint, renderRunStatus } from "../../src/application/playbook.js"
import { SqliteAdapter } from "../../src/reliability/sqlite.js"
import { RunManager } from "../../src/application/run-manager.js"

describe("least-privilege tool denial (FR-100/101)", () => {
  const reg = new AgentRegistry()
  const get = (id: string) => reg.get(id)

  test("read-only roles deny every interactive tool", () => {
    for (const id of ["explorer", "requirements-analyst", "architect"]) {
      const role = get(id)
      expect(deniedToolsForRole(role).slice().sort()).toEqual(["bash", "edit", "webfetch", "write"])
    }
  })

  test("roles allowed a tool are not denied on it", () => {
    expect(new Set(deniedToolsForRole(get("implementer")))).toEqual(new Set(["webfetch"]))
    expect(new Set(deniedToolsForRole(get("test-engineer")))).toEqual(new Set(["write", "edit", "webfetch"]))
    expect(new Set(deniedToolsForRole(get("reviewer")))).toEqual(new Set(["write", "edit", "bash", "webfetch"]))
  })
})

describe("ADR-003 role injection payloads", () => {
  const reg = new AgentRegistry()

  test("roleSystemText carries role identity, tools, policy and completion marker", () => {
    const text = roleSystemText(reg.get("explorer"), "add a feature")
    expect(text.includes('"Repository Explorer"')).toBe(true)
    expect(text.includes("add a feature")).toBe(true)
    expect(text.includes("read, grep, glob")).toBe(true)
    expect(text.includes("shared read-only")).toBe(true)
    expect(text.includes("TITAN_RESULT:")).toBe(true)
  })

  test("isolated-write roles reference the worktree", () => {
    const text = roleSystemText(reg.get("implementer"), "g")
    expect(text.includes("isolated worktree")).toBe(true)
  })

  test("taskPromptText includes task identity and criteria", () => {
    const role = reg.get("implementer")
    const task = role.suitableTaskTypes.length // touch so role used
    expect(task).toBeGreaterThan(0)
    const text = taskPromptText(
      {
        schemaVersion: 1,
        id: "TASK-1",
        runId: "RUN-1",
        type: "implementation",
        title: "Build the widget",
        status: "QUEUED",
        priority: "HIGH",
        dependencies: [],
        inputArtifactIds: ["ART-9"],
        acceptanceCriteria: [{ id: "AC-1", statement: "widget works", evidenceRequired: true }],
        limits: { maxAttempts: 3, timeoutSeconds: 60 },
        idempotencyKey: "test-key",
        attempts: 0,
        evidence: [],
        createdAt: 0,
        updatedAt: 0,
      },
      "goal text",
    )
    expect(text.includes("TASK-1")).toBe(true)
    expect(text.includes("Build the widget")).toBe(true)
    expect(text.includes("AC-1")).toBe(true)
    expect(text.includes("ART-9")).toBe(true)
  })
})

describe("result extraction", () => {
  test("extractAssistant picks the last assistant message and text parts", () => {
    const payload = [
      { type: "user", text: "prompt" },
      { id: "m1", type: "assistant", finish: "tool-calls", content: [{ type: "text", text: "working..." }] },
      { id: "m2", type: "assistant", finish: "stop", content: [{ type: "text", text: "did it" }, { type: "reasoning", text: "hmm" }], tokens: { output: 42 }, cost: 0.0 },
    ]
    const ex = extractAssistant(payload)
    expect(ex.found).toBe(true)
    expect(ex.finish).toBe("stop")
    expect(ex.text).toBe("did it")
    expect(ex.outputTokens).toBe(42)
  })

  test("extractAssistant handles wrapper shapes and empty payloads", () => {
    expect(extractAssistant({ data: [{ type: "assistant", finish: "stop", text: "x" }] }).text).toBe("x")
    expect(extractAssistant({ messages: [{ type: "assistant", finish: "stop", text: "y" }] }).text).toBe("y")
    expect(extractAssistant([]).found).toBe(false)
    expect(extractAssistant(undefined).found).toBe(false)
  })

  test("extractAssistant surfaces model errors", () => {
    const ex = extractAssistant([{ type: "assistant", finish: "error", text: "", error: { message: "boom 429" } }])
    expect(ex.errorMessage).toContain("boom")
  })

  test("classifySessionError maps families", () => {
    expect(classifySessionError(new Error("HTTP 429 too many requests"))).toBe("rate-limit")
    expect(classifySessionError(new Error("request timed out"))).toBe("session")
    expect(classifySessionError(new Error("fetch failed"))).toBe("network")
    expect(classifySessionError(new Error("permission denied"))).toBe("permission")
    expect(classifySessionError(new Error("weird"))).toBe("task-execution")
  })

  test("summarizeOutcome prefers the TITAN_RESULT line", () => {
    const text = ["step one", "step two", "TITAN_RESULT: all green"].join("\n")
    expect(summarizeOutcome(text)).toBe("TITAN_RESULT: all green")
    expect(summarizeOutcome("first\nlast visible line")).toBe("last visible line")
    expect(summarizeOutcome("")).toBe("worker returned no text")
  })
})

describe("run blueprint + status view", () => {
  test("blueprint is a 6-step chain with correct types", () => {
    const steps = runBlueprint("add a login page")
    expect(steps.map((s) => s.type)).toEqual([
      "exploration",
      "planning",
      "implementation",
      "test",
      "review",
      "integration",
    ])
    expect(steps[3]!.title).toContain("Test")
  })

  test("blueprint round-trips through RunManager (indices resolve, DAG valid)", async () => {
    const db = await SqliteAdapter.open()
    const rm = new RunManager(db, new AgentRegistry())
    const run = await rm.createRun({ goal: "login", tasks: runBlueprint("login") })
    const tasks = await rm.getTasks(run.id)
    expect(tasks).toHaveLength(6)
    expect(tasks[2]!.dependencies).toEqual([tasks[1]!.id])
    await db.close()
  })

  test("renderRunStatus shows status, counts, tasks and workers", async () => {
    const db = await SqliteAdapter.open()
    const rm = new RunManager(db, new AgentRegistry())
    const run = await rm.createRun({ goal: "g", tasks: runBlueprint("g") })
    const tasks = await rm.getTasks(run.id)
    await rm.transitionTask(tasks[0]!.id, "SKIPPED", "test skip")
    await rm.transitionRun(run.id, "PREFLIGHT", "to failed")
    await rm.transitionRun(run.id, "FAILED", "test fail")
    const view = await rm.progress(run.id)
    const out = renderRunStatus(view, 2)
    expect(out).toContain(`Run ${run.id} — FAILED (test fail)`)
    expect(out).toContain("skipped 1")
    expect(out).toContain("[SKIPPED]")
    expect(out).toContain("Workers active: 2")
    await db.close()
  })
})

describe("builtin roles registry supports blueprints", () => {
  test("every blueprint task type has a suitable role", () => {
    const reg = new AgentRegistry()
    const reg2 = new AgentRegistry()
    void reg2
    for (const type of ["exploration", "planning", "implementation", "test", "review", "integration"] as const) {
      const fit = BUILTIN_ROLES.filter((r) => r.suitableTaskTypes.includes(type))
      expect(fit.length).toBeGreaterThan(0)
      void reg
    }
  })
})
