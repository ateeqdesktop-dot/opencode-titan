import { describe, expect, test } from "bun:test"
import {
  validateRequest,
  isRpcRequest,
  makeRunSummary,
  RPC_SCHEMA_VERSION,
} from "../../src/rpc/contract.js"

describe("RPC contract (FR-005)", () => {
  test("validates known request kinds", () => {
    expect(isRpcRequest({ kind: "run.list" })).toBe(true)
    expect(isRpcRequest({ kind: "run.status", runId: "R-1" })).toBe(true)
    expect(isRpcRequest({ kind: "task.list", runId: "R-1" })).toBe(true)
    expect(isRpcRequest({ kind: "approval.list", runId: "R-1" })).toBe(true)
    expect(isRpcRequest({ kind: "approval.decide", runId: "R-1", status: "approved", decidedBy: "human" })).toBe(true)
  })

  test("rejects malformed requests", () => {
    expect(isRpcRequest(null)).toBe(false)
    expect(isRpcRequest({ kind: "nope" })).toBe(false)
    const v = validateRequest({ kind: "run.status", runId: "" })
    expect(v.ok).toBe(false)
    const v2 = validateRequest({ kind: "approval.decide", runId: "R-1", status: "maybe", decidedBy: "h" })
    expect(v2.ok).toBe(false)
    const v3 = validateRequest({ kind: "approval.decide", runId: "R-1", status: "approved", decidedBy: "" })
    expect(v3.ok).toBe(false)
  })

  test("accepts valid requests with typed output", () => {
    const v = validateRequest({ kind: "run.list" })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.req.kind).toBe("run.list")
  })

  test("makeRunSummary counts tasks and carries schema version", () => {
    const s = makeRunSummary({
      id: "R-1",
      goal: "g",
      status: "CLOSED",
      mode: "direct",
      tasks: [{ status: "SUCCEEDED" }, { status: "SUCCEEDED" }, { status: "FAILED" }, { status: "SKIPPED" }],
      activeWorkers: 0,
      closedAt: 123,
    })
    expect(s.schemaVersion).toBe(RPC_SCHEMA_VERSION)
    expect(s.tasksTotal).toBe(4)
    expect(s.tasksSucceeded).toBe(2)
    expect(s.tasksFailed).toBe(1)
    expect(s.tasksSkipped).toBe(1)
    expect(s.closedAt).toBe(123)
  })
})