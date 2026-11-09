/**
 * Budget & Resource Manager (SRS §7.5, FR-045, FR-046, FR-047).
 *
 * Enforces per-Run limits: concurrency, attempts, wall-clock, estimated cost, model calls.
 * Defaults: maxConcurrentWorkers = 4, configurable ceiling = 8 (SRS §5.4).
 *
 * FR-046: distinguish ACTUAL usage (reported by OpenCode/provider) from ESTIMATED cost
 * (computed from a price table). Never claim financial precision we cannot prove.
 */
import type { RunBudget } from "../domain/types.js"

export const DEFAULT_MAX_WORKERS = 4
export const HARD_MAX_WORKERS = 8

export class BudgetExceededError extends Error {
  constructor(
    readonly dimension: "workers" | "attempts" | "time" | "cost" | "model-calls",
    readonly detail: string,
  ) {
    super(`Budget exceeded (${dimension}): ${detail}`)
    this.name = "BudgetExceededError"
  }
}

/** Sanitize and clamp a budget to safe bounds. */
export function normalizeBudget(input: Partial<RunBudget>): RunBudget {
  const workers = clampInt(input.maxConcurrentWorkers ?? DEFAULT_MAX_WORKERS, 1, HARD_MAX_WORKERS)
  const attempts = clampInt(input.maxAttemptsPerTask ?? 3, 1, 20)
  const seconds = clampInt(input.maxTotalSeconds ?? 3600, 10, 86_400)
  const cost = input.maxEstimatedCostUsd !== undefined ? Math.max(0, input.maxEstimatedCostUsd) : undefined
  const calls = input.maxModelCalls !== undefined ? clampInt(input.maxModelCalls, 1, 1_000_000) : undefined
  return {
    maxConcurrentWorkers: workers,
    maxAttemptsPerTask: attempts,
    maxTotalSeconds: seconds,
    ...(cost !== undefined ? { maxEstimatedCostUsd: cost } : {}),
    ...(calls !== undefined ? { maxModelCalls: calls } : {}),
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return Math.min(hi, Math.max(lo, Math.floor(v)))
}

export interface BudgetUsage {
  readonly modelCalls: number
  readonly estimatedCostUsd: number
  /** Actual cost if the provider/OpenCode reported it (FR-046). */
  readonly actualCostUsd?: number
  readonly startedAt: number
}

export class BudgetManager {
  private usage: BudgetUsage
  private readonly budget: RunBudget

  constructor(budget: RunBudget, startedAt: number = Date.now()) {
    this.budget = normalizeBudget(budget)
    this.usage = { modelCalls: 0, estimatedCostUsd: 0, startedAt }
  }

  get limits(): RunBudget {
    return this.budget
  }

  get current(): BudgetUsage {
    return this.usage
  }

  /** Record one model call with an estimated cost (from a price table, FR-046). */
  recordModelCall(estimatedCostUsd: number): void {
    this.usage = {
      ...this.usage,
      modelCalls: this.usage.modelCalls + 1,
      estimatedCostUsd: this.usage.estimatedCostUsd + Math.max(0, estimatedCostUsd),
    }
  }

  /** Record actual usage reported by the provider/OpenCode (FR-046). */
  recordActualCost(actualUsd: number): void {
    this.usage = { ...this.usage, actualCostUsd: (this.usage.actualCostUsd ?? 0) + Math.max(0, actualUsd) }
  }

  /** Milliseconds elapsed since budget start. */
  elapsedMs(now: number = Date.now()): number {
    return now - this.usage.startedAt
  }

  /** True if scheduling NEW work must stop (FR-047). */
  shouldStopScheduling(now: number = Date.now()): { stop: boolean; reason?: string } {
    if (this.budget.maxModelCalls !== undefined && this.usage.modelCalls >= this.budget.maxModelCalls) {
      return { stop: true, reason: `model call budget reached (${this.usage.modelCalls}/${this.budget.maxModelCalls})` }
    }
    if (
      this.budget.maxEstimatedCostUsd !== undefined &&
      this.usage.estimatedCostUsd >= this.budget.maxEstimatedCostUsd
    ) {
      return {
        stop: true,
        reason: `estimated cost budget reached ($${this.usage.estimatedCostUsd.toFixed(4)}/$${this.budget.maxEstimatedCostUsd})`,
      }
    }
    if (this.elapsedMs(now) >= this.budget.maxTotalSeconds * 1000) {
      return { stop: true, reason: `wall-clock budget reached (${this.budget.maxTotalSeconds}s)` }
    }
    return { stop: false }
  }

  /** Throw if a new model call would exceed budget (call BEFORE dispatching). */
  assertCanSpend(estimatedCostUsd = 0, now: number = Date.now()): void {
    const s = this.shouldStopScheduling(now)
    if (s.stop) throw new BudgetExceededError("cost", s.reason ?? "budget exhausted")
    if (
      this.budget.maxEstimatedCostUsd !== undefined &&
      this.usage.estimatedCostUsd + estimatedCostUsd > this.budget.maxEstimatedCostUsd
    ) {
      throw new BudgetExceededError("cost", `projected cost would exceed $${this.budget.maxEstimatedCostUsd}`)
    }
  }

  /** Attempts allowed for a single task (FR-045). */
  canAttempt(currentAttempts: number): boolean {
    return currentAttempts < this.budget.maxAttemptsPerTask
  }

  /** Max concurrent workers, clamped to the hard ceiling. */
  get maxWorkers(): number {
    return this.budget.maxConcurrentWorkers
  }

  /** A human-readable report distinguishing actual vs estimated (FR-046, FR-108). */
  report(): {
    estimatedCostUsd: number
    actualCostUsd?: number
    modelCalls: number
    maxWorkers: number
    maxModelCalls?: number
    elapsedMs: number
    costBasis: "estimated" | "actual+estimated"
  } {
    const base = {
      estimatedCostUsd: this.usage.estimatedCostUsd,
      modelCalls: this.usage.modelCalls,
      maxWorkers: this.budget.maxConcurrentWorkers,
      elapsedMs: this.elapsedMs(),
      costBasis: (this.usage.actualCostUsd !== undefined ? "actual+estimated" : "estimated") as
        | "estimated"
        | "actual+estimated",
    }
    if (this.usage.actualCostUsd !== undefined) {
      return { ...base, actualCostUsd: this.usage.actualCostUsd, maxModelCalls: this.budget.maxModelCalls }
    }
    return { ...base, maxModelCalls: this.budget.maxModelCalls }
  }
}
