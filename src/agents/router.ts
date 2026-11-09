/**
 * Model Router (SRS §7.5, FR-040..FR-044).
 *
 * FR-040: discover available models via OpenCode — never assume a provider/model exists.
 * FR-042: route only within an allowlist; never switch provider outside it.
 * FR-043: record WHY a model was chosen (and the fallback), allow manual pinning.
 * FR-044: fallback only on provider/model failure and only if policy allows, logging the switch.
 *
 * This module is pure decision logic. The OpenCode adapter supplies the live model list
 * (from `ctx.model.list()`); the router does not talk to OpenCode directly.
 */

export interface ModelCandidate {
  readonly providerID: string
  readonly modelID: string
  readonly name?: string
  readonly costInputPerMTok?: number
  readonly costOutputPerMTok?: number
  readonly supportsTools?: boolean
  readonly contextLimit?: number
}

export interface RouteDecision {
  readonly providerID: string
  readonly modelID: string
  /** Why this model (FR-043). */
  readonly reason: string
  /** The fallback that would be used if this fails (FR-044), if any. */
  readonly fallback?: { providerID: string; modelID: string; reason: string }
  /** Whether the choice was a manual pin (disables auto-routing). */
  readonly pinned: boolean
}

export interface RouteRequest {
  readonly taskType: string
  readonly requiresTools: boolean
  /** Optional user pin: "provider/model". If set, auto-routing is bypassed (FR-043). */
  readonly pinnedModel?: string
  /** Allowlist of "provider/model" entries. Empty/undefined = all discovered models allowed. */
  readonly allowlist?: readonly string[]
  /** Ordered preferred models (role preference), best first. */
  readonly preferred?: readonly string[]
  /** Whether a fallback may be used on failure (FR-044 policy). */
  readonly allowFallback: boolean
}

export class ModelRouterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelRouterError"
  }
}

const ref = (m: ModelCandidate): string => `${m.providerID}/${m.modelID}`

export class ModelRouter {
  private available: ModelCandidate[] = []

  /** Replace the discovered model catalog (FR-040 — fed from ctx.model.list()). */
  setAvailable(models: readonly ModelCandidate[]): void {
    this.available = [...models]
  }

  getAvailable(): readonly ModelCandidate[] {
    return this.available
  }

  /** Filter to the allowlist (FR-042). Empty allowlist → everything allowed. */
  private allowlisted(allowlist?: readonly string[]): ModelCandidate[] {
    if (!allowlist || allowlist.length === 0) return this.available
    const set = new Set(allowlist)
    return this.available.filter((m) => set.has(ref(m)))
  }

  /** Choose a model for a task. Throws if nothing eligible (never guesses a model). */
  route(req: RouteRequest): RouteDecision {
    // 1) Manual pin wins and disables auto-routing (FR-043).
    if (req.pinnedModel) {
      const pinned = this.available.find((m) => ref(m) === req.pinnedModel)
      if (!pinned) {
        throw new ModelRouterError(`Pinned model not available: ${req.pinnedModel}`)
      }
      // Even a pin must respect the allowlist if one is configured (FR-042).
      if (req.allowlist && req.allowlist.length > 0 && !req.allowlist.includes(req.pinnedModel)) {
        throw new ModelRouterError(`Pinned model ${req.pinnedModel} is outside the allowlist`)
      }
      const fb = this.pickFallback(pinned, req)
      return {
        providerID: pinned.providerID,
        modelID: pinned.modelID,
        reason: `manually pinned by user (auto-routing disabled)`,
        pinned: true,
        ...(fb ? { fallback: { providerID: fb.providerID, modelID: fb.modelID, reason: "policy-allowed alternate on failure" } } : {}),
      }
    }

    const pool = this.allowlisted(req.allowlist)
    if (pool.length === 0) {
      throw new ModelRouterError(
        req.allowlist?.length
          ? "No available model matches the allowlist"
          : "No models discovered from OpenCode (ctx.model.list() empty)",
      )
    }

    // 2) Capability filter: tools required → must support tools.
    let candidates = pool
    if (req.requiresTools) {
      const toolCapable = candidates.filter((m) => m.supportsTools !== false)
      // If we can't tell (undefined), treat as capable to avoid over-filtering.
      candidates = toolCapable.length > 0 ? toolCapable : candidates
    }

    // 3) Role preference order.
    if (req.preferred && req.preferred.length > 0) {
      for (const pref of req.preferred) {
        const hit = candidates.find((m) => ref(m) === pref)
        if (hit) {
          return this.decide(hit, `preferred by role for task type ${req.taskType}`, candidates, req)
        }
      }
    }

    // 4) Default: cheapest tool-capable model (cost control, G-03).
    const sorted = [...candidates].sort(
      (a, b) => (a.costInputPerMTok ?? Infinity) - (b.costInputPerMTok ?? Infinity),
    )
    const chosen = sorted[0]!
    return this.decide(
      chosen,
      `cheapest eligible model for task type ${req.taskType} within allowlist`,
      candidates,
      req,
    )
  }

  private decide(
    chosen: ModelCandidate,
    reason: string,
    candidates: readonly ModelCandidate[],
    req: RouteRequest,
  ): RouteDecision {
    const fb = req.allowFallback ? this.pickFallback(chosen, candidates, req) : undefined
    const d: RouteDecision = {
      providerID: chosen.providerID,
      modelID: chosen.modelID,
      reason,
      pinned: false,
    }
    if (fb) {
      return {
        ...d,
        fallback: { providerID: fb.providerID, modelID: fb.modelID, reason: "policy-allowed alternate on failure" },
      }
    }
    return d
  }

  /** Pick a different model than `exclude` to serve as fallback (FR-044). */
  private pickFallback(
    exclude: ModelCandidate,
    reqOrCandidates: RouteRequest | readonly ModelCandidate[],
    maybeReq?: RouteRequest,
  ): ModelCandidate | undefined {
    // Handle both call shapes used above.
    let candidates: readonly ModelCandidate[]
    let req: RouteRequest | undefined
    if (Array.isArray(reqOrCandidates)) {
      candidates = reqOrCandidates as readonly ModelCandidate[]
      req = maybeReq
    } else {
      req = reqOrCandidates as RouteRequest
      candidates = this.allowlisted(req.allowlist)
    }
    if (!req?.allowFallback) return undefined
    const ex = ref(exclude)
    return candidates.find((m) => ref(m) !== ex && m.supportsTools !== false)
  }

  /**
   * Record a runtime failure and switch to the fallback if policy allows (FR-044).
   * Returns the new decision and a loggable reason, or null if no fallback permitted.
   */
  onFailure(current: RouteDecision, error: string): { decision: RouteDecision; switched: true; reason: string } | null {
    if (!current.fallback) return null
    return {
      decision: {
        providerID: current.fallback.providerID,
        modelID: current.fallback.modelID,
        reason: `fallback after failure of ${current.providerID}/${current.modelID}: ${error}`,
        pinned: false,
      },
      switched: true,
      reason: `switched ${current.providerID}/${current.modelID} -> ${current.fallback.providerID}/${current.fallback.modelID} (${error})`,
    }
  }
}
