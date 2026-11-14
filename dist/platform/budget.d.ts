/**
 * Budget & Resource Manager (SRS §7.5, FR-045, FR-046, FR-047).
 *
 * Enforces per-Run limits: concurrency, attempts, wall-clock, estimated cost, model calls.
 * Defaults: maxConcurrentWorkers = 4, configurable ceiling = 8 (SRS §5.4).
 *
 * FR-046: distinguish ACTUAL usage (reported by OpenCode/provider) from ESTIMATED cost
 * (computed from a price table). Never claim financial precision we cannot prove.
 */
import type { RunBudget } from "../domain/types.js";
export declare const DEFAULT_MAX_WORKERS = 4;
export declare const HARD_MAX_WORKERS = 8;
export declare class BudgetExceededError extends Error {
    readonly dimension: "workers" | "attempts" | "time" | "cost" | "model-calls";
    readonly detail: string;
    constructor(dimension: "workers" | "attempts" | "time" | "cost" | "model-calls", detail: string);
}
/** Sanitize and clamp a budget to safe bounds. */
export declare function normalizeBudget(input: Partial<RunBudget>): RunBudget;
export interface BudgetUsage {
    readonly modelCalls: number;
    readonly estimatedCostUsd: number;
    /** Actual cost if the provider/OpenCode reported it (FR-046). */
    readonly actualCostUsd?: number;
    readonly startedAt: number;
}
export declare class BudgetManager {
    private usage;
    private readonly budget;
    constructor(budget: RunBudget, startedAt?: number);
    get limits(): RunBudget;
    get current(): BudgetUsage;
    /** Record one model call with an estimated cost (from a price table, FR-046). */
    recordModelCall(estimatedCostUsd: number): void;
    /** Record actual usage reported by the provider/OpenCode (FR-046). */
    recordActualCost(actualUsd: number): void;
    /** Milliseconds elapsed since budget start. */
    elapsedMs(now?: number): number;
    /** True if scheduling NEW work must stop (FR-047). */
    shouldStopScheduling(now?: number): {
        stop: boolean;
        reason?: string;
    };
    /** Throw if a new model call would exceed budget (call BEFORE dispatching). */
    assertCanSpend(estimatedCostUsd?: number, now?: number): void;
    /** Attempts allowed for a single task (FR-045). */
    canAttempt(currentAttempts: number): boolean;
    /** Max concurrent workers, clamped to the hard ceiling. */
    get maxWorkers(): number;
    /** A human-readable report distinguishing actual vs estimated (FR-046, FR-108). */
    report(): {
        estimatedCostUsd: number;
        actualCostUsd?: number;
        modelCalls: number;
        maxWorkers: number;
        maxModelCalls?: number;
        elapsedMs: number;
        costBasis: "estimated" | "actual+estimated";
    };
}
