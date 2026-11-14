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
import { type RunFullState, type TaskState } from "./types.js";
export declare class IllegalTransitionError extends Error {
    readonly entity: "run" | "task";
    readonly from: string;
    readonly to: string;
    constructor(entity: "run" | "task", from: string, to: string);
}
/** Returns true if `to` is a legal next state from `from`. */
export declare function canTransitionRun(from: RunFullState, to: RunFullState): boolean;
export declare function canTransitionTask(from: TaskState, to: TaskState): boolean;
/**
 * Apply a Run transition or throw. Never allows FAILED -> SUCCEEDED or any
 * transition not in the SRS table.
 */
export declare function transitionRun(from: RunFullState, to: RunFullState): RunFullState;
/** Apply a Task transition or throw. */
export declare function transitionTask(from: TaskState, to: TaskState): TaskState;
/** Terminal Run states — no outgoing transitions. */
export declare function isRunTerminal(s: RunFullState): boolean;
/** Terminal Task states (SUCCEEDED/FAILED-with-no-rework/CANCELLED/SKIPPED). */
export declare function isTaskTerminal(s: TaskState): boolean;
/**
 * The SRS explicitly forbids FAILED -> SUCCEEDED without a re-run. This predicate
 * exists so tests can assert the guard directly, independent of the table.
 */
export declare function wouldIllegallySucceed(from: TaskState, to: TaskState): boolean;
