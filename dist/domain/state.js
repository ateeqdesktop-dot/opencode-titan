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
import { RUN_TRANSITIONS, TASK_TRANSITIONS, } from "./types.js";
export class IllegalTransitionError extends Error {
    entity;
    from;
    to;
    constructor(entity, from, to) {
        super(`Illegal ${entity} transition: ${from} -> ${to}`);
        this.entity = entity;
        this.from = from;
        this.to = to;
        this.name = "IllegalTransitionError";
    }
}
/** Returns true if `to` is a legal next state from `from`. */
export function canTransitionRun(from, to) {
    const allowed = RUN_TRANSITIONS[from];
    if (!allowed)
        return false;
    return allowed.includes(to);
}
export function canTransitionTask(from, to) {
    const allowed = TASK_TRANSITIONS[from];
    if (!allowed)
        return false;
    return allowed.includes(to);
}
/**
 * Apply a Run transition or throw. Never allows FAILED -> SUCCEEDED or any
 * transition not in the SRS table.
 */
export function transitionRun(from, to) {
    if (!canTransitionRun(from, to))
        throw new IllegalTransitionError("run", from, to);
    return to;
}
/** Apply a Task transition or throw. */
export function transitionTask(from, to) {
    if (!canTransitionTask(from, to))
        throw new IllegalTransitionError("task", from, to);
    return to;
}
/** Terminal Run states — no outgoing transitions. */
export function isRunTerminal(s) {
    return s === "CLOSED";
}
/** Terminal Task states (SUCCEEDED/FAILED-with-no-rework/CANCELLED/SKIPPED). */
export function isTaskTerminal(s) {
    return s === "SUCCEEDED" || s === "CANCELLED" || s === "SKIPPED";
}
/**
 * The SRS explicitly forbids FAILED -> SUCCEEDED without a re-run. This predicate
 * exists so tests can assert the guard directly, independent of the table.
 */
export function wouldIllegallySucceed(from, to) {
    return from === "FAILED" && to === "SUCCEEDED";
}
