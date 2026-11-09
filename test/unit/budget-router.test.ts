import { describe, expect, test } from "bun:test"
import {
  BudgetExceededError,
  BudgetManager,
  DEFAULT_MAX_WORKERS,
  HARD_MAX_WORKERS,
  normalizeBudget,
} from "../../src/platform/budget.js"
import { ModelRouter, ModelRouterError, type ModelCandidate } from "../../src/agents/router.js"

const models: ModelCandidate[] = [
  { providerID: "opencode", modelID: "expensive", costInputPerMTok: 10, supportsTools: true },
  { providerID: "opencode", modelID: "cheap-free", costInputPerMTok: 0, supportsTools: true },
  { providerID: "opencode", modelID: "mid", costInputPerMTok: 2, supportsTools: true },
  { providerID: "other", modelID: "no-tools", costInputPerMTok: 1, supportsTools: false },
]

describe("Budget normalization (FR-045, §5.4)", () => {
  test("defaults to 4 workers", () => {
    expect(normalizeBudget({}).maxConcurrentWorkers).toBe(DEFAULT_MAX_WORKERS)
    expect(DEFAULT_MAX_WORKERS).toBe(4)
  })

  test("clamps workers to hard ceiling of 8", () => {
    expect(normalizeBudget({ maxConcurrentWorkers: 99 }).maxConcurrentWorkers).toBe(HARD_MAX_WORKERS)
    expect(HARD_MAX_WORKERS).toBe(8)
    expect(normalizeBudget({ maxConcurrentWorkers: 0 }).maxConcurrentWorkers).toBe(1)
  })

  test("rejects non-finite values safely", () => {
    const b = normalizeBudget({ maxConcurrentWorkers: Number.NaN })
    expect(b.maxConcurrentWorkers).toBe(1)
  })
})

describe("BudgetManager limits (FR-045/047)", () => {
  test("stops scheduling when model-call budget reached", () => {
    const bm = new BudgetManager({ maxConcurrentWorkers: 4, maxAttemptsPerTask: 3, maxTotalSeconds: 60, maxModelCalls: 2 })
    bm.recordModelCall(0)
    expect(bm.shouldStopScheduling().stop).toBe(false)
    bm.recordModelCall(0)
    expect(bm.shouldStopScheduling().stop).toBe(true)
    expect(() => bm.assertCanSpend()).toThrow(BudgetExceededError)
  })

  test("stops scheduling when estimated cost budget reached", () => {
    const bm = new BudgetManager({
      maxConcurrentWorkers: 4,
      maxAttemptsPerTask: 3,
      maxTotalSeconds: 60,
      maxEstimatedCostUsd: 1,
    })
    bm.recordModelCall(0.6)
    expect(bm.shouldStopScheduling().stop).toBe(false)
    bm.recordModelCall(0.6) // total 1.2 > 1
    expect(bm.shouldStopScheduling().stop).toBe(true)
  })

  test("assertCanSpend projects before dispatch", () => {
    const bm = new BudgetManager({
      maxConcurrentWorkers: 4,
      maxAttemptsPerTask: 3,
      maxTotalSeconds: 60,
      maxEstimatedCostUsd: 1,
    })
    expect(() => bm.assertCanSpend(0.5)).not.toThrow()
    expect(() => bm.assertCanSpend(2)).toThrow(BudgetExceededError)
  })

  test("wall-clock budget stops scheduling", () => {
    const start = 1000
    const bm = new BudgetManager({ maxConcurrentWorkers: 4, maxAttemptsPerTask: 3, maxTotalSeconds: 10 }, start)
    expect(bm.shouldStopScheduling(start + 5000).stop).toBe(false)
    expect(bm.shouldStopScheduling(start + 11000).stop).toBe(true)
  })

  test("canAttempt respects maxAttemptsPerTask", () => {
    const bm = new BudgetManager({ maxConcurrentWorkers: 4, maxAttemptsPerTask: 3, maxTotalSeconds: 60 })
    expect(bm.canAttempt(0)).toBe(true)
    expect(bm.canAttempt(2)).toBe(true)
    expect(bm.canAttempt(3)).toBe(false)
    expect(bm.canAttempt(4)).toBe(false)
  })

  test("report distinguishes actual vs estimated cost (FR-046)", () => {
    const bm = new BudgetManager({ maxConcurrentWorkers: 4, maxAttemptsPerTask: 3, maxTotalSeconds: 60 })
    bm.recordModelCall(0.01)
    let rep = bm.report()
    expect(rep.costBasis).toBe("estimated") // no actual data yet → must be labeled estimated
    expect(rep.estimatedCostUsd).toBeCloseTo(0.01)
    bm.recordActualCost(0.02)
    rep = bm.report()
    expect(rep.costBasis).toBe("actual+estimated")
    expect(rep.actualCostUsd).toBeCloseTo(0.02)
  })
})

describe("ModelRouter (FR-040..044)", () => {
  const router = () => {
    const r = new ModelRouter()
    r.setAvailable(models)
    return r
  }

  test("routes within discovered models, never invents one (FR-040)", () => {
    const d = router().route({
      taskType: "implementation",
      requiresTools: true,
      allowFallback: false,
    })
    expect(models.some((m) => m.providerID === d.providerID && m.modelID === d.modelID)).toBe(true)
    expect(d.reason.length).toBeGreaterThan(0)
  })

  test("empty catalog throws instead of guessing (FR-040)", () => {
    const r = new ModelRouter()
    r.setAvailable([])
    expect(() =>
      r.route({ taskType: "implementation", requiresTools: true, allowFallback: false }),
    ).toThrow(ModelRouterError)
  })

  test("allowlist is enforced — never routes outside it (FR-042)", () => {
    const d = router().route({
      taskType: "implementation",
      requiresTools: true,
      allowlist: ["opencode/cheap-free"],
      allowFallback: false,
    })
    expect(`${d.providerID}/${d.modelID}`).toBe("opencode/cheap-free")
    // an allowlist excluding everything eligible throws
    expect(() =>
      router().route({ taskType: "implementation", requiresTools: true, allowlist: ["none/none"], allowFallback: false }),
    ).toThrow(ModelRouterError)
  })

  test("manual pin disables auto-routing and records why (FR-043)", () => {
    const d = router().route({
      taskType: "implementation",
      requiresTools: true,
      pinnedModel: "opencode/expensive",
      allowFallback: false,
    })
    expect(`${d.providerID}/${d.modelID}`).toBe("opencode/expensive")
    expect(d.pinned).toBe(true)
    expect(d.reason).toMatch(/pinned/)
  })

  test("pin outside allowlist is rejected (FR-042 beats FR-043)", () => {
    expect(() =>
      router().route({
        taskType: "implementation",
        requiresTools: true,
        pinnedModel: "other/no-tools",
        allowlist: ["opencode/mid"],
        allowFallback: false,
      }),
    ).toThrow(/outside the allowlist/)
  })

  test("pin of unavailable model throws (never fabricate)", () => {
    expect(() =>
      router().route({ taskType: "x", requiresTools: false, pinnedModel: "ghost/ghost", allowFallback: false }),
    ).toThrow(/not available/)
  })

  test("prefers role-preferred model when eligible", () => {
    const d = router().route({
      taskType: "implementation",
      requiresTools: true,
      preferred: ["opencode/mid", "opencode/cheap-free"],
      allowFallback: false,
    })
    expect(`${d.providerID}/${d.modelID}`).toBe("opencode/mid")
  })

  test("defaults to cheapest eligible model (cost control G-03)", () => {
    const d = router().route({ taskType: "implementation", requiresTools: true, allowFallback: false })
    expect(`${d.providerID}/${d.modelID}`).toBe("opencode/cheap-free")
  })

  test("requiresTools filters out non-tool models when possible", () => {
    // With only the no-tool model present and tools required, it should still be usable
    // as a last resort (we don't over-filter), but a tool model is preferred when present.
    const r = new ModelRouter()
    r.setAvailable([models[3]!]) // only no-tools
    const d = r.route({ taskType: "implementation", requiresTools: true, allowFallback: false })
    expect(`${d.providerID}/${d.modelID}`).toBe("other/no-tools")
  })

  test("fallback provided only when policy allows (FR-044)", () => {
    const withFb = router().route({ taskType: "implementation", requiresTools: true, allowFallback: true })
    expect(withFb.fallback).toBeDefined()
    expect(withFb.fallback!.modelID).not.toBe(withFb.modelID)

    const noFb = router().route({ taskType: "implementation", requiresTools: true, allowFallback: false })
    expect(noFb.fallback).toBeUndefined()
  })

  test("onFailure switches to fallback and logs reason (FR-044)", () => {
    const d = router().route({ taskType: "implementation", requiresTools: true, allowFallback: true })
    const res = router().onFailure(d, "provider timeout")
    expect(res).not.toBeNull()
    expect(res!.switched).toBe(true)
    expect(res!.decision.modelID).not.toBe(d.modelID)
    expect(res!.reason).toMatch(/provider timeout/)
  })

  test("onFailure returns null when no fallback (no silent switch)", () => {
    const d = router().route({ taskType: "implementation", requiresTools: true, allowFallback: false })
    expect(router().onFailure(d, "boom")).toBeNull()
  })
})
