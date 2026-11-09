import { describe, expect, test } from "bun:test"
import {
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  isRetryable,
  type RunFullState,
  type TaskState,
} from "../../src/domain/types.js"
import {
  IllegalTransitionError,
  canTransitionRun,
  canTransitionTask,
  isRunTerminal,
  isTaskTerminal,
  transitionRun,
  transitionTask,
  wouldIllegallySucceed,
} from "../../src/domain/state.js"

describe("Run state machine (SRS §8.2)", () => {
  test("legal happy path transitions", () => {
    expect(canTransitionRun("CREATED", "PREFLIGHT")).toBe(true)
    expect(canTransitionRun("PREFLIGHT", "ANALYZING")).toBe(true)
    expect(canTransitionRun("ANALYZING", "PLANNING")).toBe(true)
    expect(canTransitionRun("PLANNING", "AWAITING_APPROVAL")).toBe(true)
    expect(canTransitionRun("AWAITING_APPROVAL", "READY")).toBe(true)
    expect(canTransitionRun("READY", "RUNNING")).toBe(true)
    expect(canTransitionRun("RUNNING", "VERIFYING")).toBe(true)
    expect(canTransitionRun("VERIFYING", "SUCCEEDED")).toBe(true)
    expect(canTransitionRun("SUCCEEDED", "CLOSED")).toBe(true)
  })

  test("FAILED cannot jump to SUCCEEDED (must go through closed or repair)", () => {
    expect(canTransitionRun("FAILED", "SUCCEEDED")).toBe(false)
    expect(canTransitionRun("FAILED", "CLOSED")).toBe(true)
  })

  test("illegal transitions are rejected", () => {
    expect(canTransitionRun("CREATED", "RUNNING")).toBe(false)
    expect(canTransitionRun("CREATED", "SUCCEEDED")).toBe(false)
    expect(canTransitionRun("SUCCEEDED", "RUNNING")).toBe(false)
    expect(canTransitionRun("CLOSED", "READY")).toBe(false)
  })

  test("transitionRun throws IllegalTransitionError on violation", () => {
    expect(() => transitionRun("CREATED", "SUCCEEDED")).toThrow(IllegalTransitionError)
    expect(transitionRun("CREATED", "PREFLIGHT")).toBe("PREFLIGHT")
  })

  test("CLOSED is terminal; every terminal state has no outgoing edges", () => {
    expect(isRunTerminal("CLOSED")).toBe(true)
    expect(RUN_TRANSITIONS.CLOSED).toHaveLength(0)
    expect(RUN_TRANSITIONS.SUCCEEDED).toEqual(["CLOSED"])
  })

  test("every state in RUN_TRANSITIONS has an entry (exhaustive)", () => {
    const states: RunFullState[] = [
      "CREATED",
      "PREFLIGHT",
      "ANALYZING",
      "PLANNING",
      "AWAITING_APPROVAL",
      "READY",
      "RUNNING",
      "VERIFYING",
      "REPAIRING",
      "PAUSED",
      "NEEDS_HUMAN",
      "SUCCEEDED",
      "FAILED",
      "REJECTED",
      "CANCELLED",
      "CLOSED",
      "BLOCKED",
      "NEEDS_INPUT",
      "WAIVED",
    ]
    for (const s of states) {
      expect(RUN_TRANSITIONS[s as never]).toBeDefined()
    }
  })
})

describe("Task state machine (SRS §8.3)", () => {
  test("FAILED never goes directly to SUCCEEDED", () => {
    expect(wouldIllegallySucceed("FAILED", "SUCCEEDED")).toBe(true)
    expect(canTransitionTask("FAILED", "SUCCEEDED")).toBe(false)
    // must go through rework then a real re-run
    expect(canTransitionTask("FAILED", "NEEDS_REWORK")).toBe(true)
    expect(canTransitionTask("NEEDS_REWORK", "QUEUED")).toBe(true)
  })

  test("happy path", () => {
    expect(canTransitionTask("DRAFT", "READY")).toBe(true)
    expect(canTransitionTask("READY", "QUEUED")).toBe(true)
    expect(canTransitionTask("QUEUED", "RUNNING")).toBe(true)
    expect(canTransitionTask("RUNNING", "VERIFYING")).toBe(true)
    expect(canTransitionTask("VERIFYING", "SUCCEEDED")).toBe(true)
  })

  test("SUCCEEDED/CANCELLED/SKIPPED are terminal", () => {
    expect(isTaskTerminal("SUCCEEDED")).toBe(true)
    expect(isTaskTerminal("CANCELLED")).toBe(true)
    expect(isTaskTerminal("SKIPPED")).toBe(true)
    expect(isTaskTerminal("RUNNING")).toBe(false)
    expect(TASK_TRANSITIONS.SUCCEEDED).toHaveLength(0)
    expect(TASK_TRANSITIONS.CANCELLED).toHaveLength(0)
    expect(TASK_TRANSITIONS.SKIPPED).toHaveLength(0)
  })

  test("SKIPPED cannot be reached from a failed run to mask failure", () => {
    // A running task does not silently become SKIPPED; it must fail or cancel.
    expect(canTransitionTask("RUNNING", "SKIPPED")).toBe(false)
    expect(canTransitionTask("FAILED", "SKIPPED")).toBe(false)
  })

  test("transitionTask throws on illegal move", () => {
    expect(() => transitionTask("FAILED", "SUCCEEDED")).toThrow(IllegalTransitionError)
    expect(transitionTask("DRAFT", "READY")).toBe("READY")
  })

  test("every task state has an entry (exhaustive)", () => {
    const all: TaskState[] = [
      "DRAFT",
      "BLOCKED",
      "READY",
      "QUEUED",
      "RUNNING",
      "WAITING_APPROVAL",
      "VERIFYING",
      "NEEDS_REWORK",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "SKIPPED",
    ]
    for (const s of all) expect(TASK_TRANSITIONS[s]).toBeDefined()
  })
})

describe("error retry classification (SRS §12.1)", () => {
  test("transient errors are retryable", () => {
    expect(isRetryable("rate-limit")).toBe(true)
    expect(isRetryable("network")).toBe(true)
    expect(isRetryable("provider")).toBe(true)
    expect(isRetryable("test-failure")).toBe(true)
  })

  test("permission/schema/config errors are NEVER auto-retried", () => {
    expect(isRetryable("permission")).toBe(false)
    expect(isRetryable("validation")).toBe(false)
    expect(isRetryable("config")).toBe(false)
    expect(isRetryable("merge-conflict")).toBe(false)
    expect(isRetryable("storage")).toBe(false)
  })
})
