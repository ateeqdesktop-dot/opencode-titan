/**
 * State machines for Run and Task.
 * SRS §8.2 (Run), §8.3 (Task). Enforces legal transitions; rejects illegal ones.
 *
 * Key SRS rules enforced here:
 *  - FAILED never transitions directly to SUCCEEDED (must go through rework/re-run).
 *  - A task cannot start before its dependencies complete (DAG engine enforces the
 *    dependency half; this enforces the status half).
 *  - SKIPPED/CANCELLED are terminal and never used to mask a failure.
 */
import {
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  type RunFullState,
  type RunState,
  type TaskState,
} from "./types.js"

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: "run" | "task",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`)
    this.name = "IllegalTransitionError"
  }
}

/** Returns true if `to` is a legal next state from `from`. */
export function canTransitionRun(from: RunFullState, to: RunFullState): boolean {
  const allowed = RUN_TRANSITIONS[from as RunState]
  if (!allowed) return false
  return (allowed as readonly string[]).includes(to)
}

export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  const allowed = TASK_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * Apply a Run transition or throw. Never allows FAILED -> SUCCEEDED or any
 * transition not in the SRS table.
 */
export function transitionRun(from: RunFullState, to: RunFullState): RunFullState {
  if (!canTransitionRun(from, to)) throw new IllegalTransitionError("run", from, to)
  return to
}

/** Apply a Task transition or throw. */
export function transitionTask(from: TaskState, to: TaskState): TaskState {
  if (!canTransitionTask(from, to)) throw new IllegalTransitionError("task", from, to)
  return to
}

/** Terminal Run states — no outgoing transitions. */
export function isRunTerminal(s: RunFullState): boolean {
  return s === "CLOSED"
}

/** Terminal Task states (SUCCEEDED/FAILED-with-no-rework/CANCELLED/SKIPPED). */
export function isTaskTerminal(s: TaskState): boolean {
  return s === "SUCCEEDED" || s === "CANCELLED" || s === "SKIPPED"
}

/**
 * The SRS explicitly forbids FAILED -> SUCCEEDED without a re-run. This predicate
 * exists so tests can assert the guard directly, independent of the table.
 */
export function wouldIllegallySucceed(from: TaskState, to: TaskState): boolean {
  return from === "FAILED" && to === "SUCCEEDED"
}
