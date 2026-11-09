import { describe, expect, test } from "bun:test"
import { verifyExecution, needsApproval } from "../../src/verification/gates.js"
import type { Task } from "../../src/domain/types.js"
import type { TaskExecutionResult } from "../../src/orchestration/orchestrator.js"

const task = (type: Task["type"], crit: Task["acceptanceCriteria"] = []): Task => ({
  schemaVersion: 1,
  id: "TASK-1",
  runId: "RUN-1",
  type,
  title: "t",
  status: "RUNNING",
  priority: "MEDIUM",
  dependencies: [],
  inputArtifactIds: [],
  acceptanceCriteria: crit,
  limits: { maxAttempts: 2, timeoutSeconds: 60 },
  idempotencyKey: "k",
  attempts: 1,
  evidence: [],
  createdAt: 0,
  updatedAt: 0,
})

const result = (evidence: TaskExecutionResult["evidence"]): TaskExecutionResult => ({
  ok: true,
  evidence,
})

describe("verification gates (SRS §9)", () => {
  test("AC requiring evidence fails when no evidence present", () => {
    const t = task("exploration", [{ id: "AC-1", statement: "x", evidenceRequired: true }])
    const v = verifyExecution(t, result([]))
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.includes("AC-1"))).toBe(true)
  })

  test("AC requiring evidence passes when evidence present", () => {
    const t = task("exploration", [{ id: "AC-1", statement: "x", evidenceRequired: true }])
    const v = verifyExecution(t, result([{ kind: "log", ref: "r", summary: "ok" }]))
    expect(v.ok).toBe(true)
  })

  test("test tasks must produce evidence", () => {
    expect(verifyExecution(task("test"), result([])).ok).toBe(false)
    expect(verifyExecution(task("test"), result([{ kind: "test", ref: "r", summary: "pass" }])).ok).toBe(true)
  })

  test("implementation tasks must produce evidence", () => {
    expect(verifyExecution(task("implementation"), result([])).ok).toBe(false)
    expect(verifyExecution(task("implementation"), result([{ kind: "diff", ref: "r", summary: "changed" }])).ok).toBe(true)
  })

  test("read-only roles don't need evidence for non-gated types", () => {
    const t = task("exploration", [{ id: "AC-2", statement: "read", evidenceRequired: false }])
    expect(verifyExecution(t, result([])).ok).toBe(true)
  })

  test("needsApproval classifies mutating task types only", () => {
    expect(needsApproval(task("implementation"))).toBe(true)
    expect(needsApproval(task("test"))).toBe(true)
    expect(needsApproval(task("integration"))).toBe(true)
    expect(needsApproval(task("exploration"))).toBe(false)
    expect(needsApproval(task("review"))).toBe(false)
  })
})