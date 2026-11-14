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
    readonly providerID: string;
    readonly modelID: string;
    readonly name?: string;
    readonly costInputPerMTok?: number;
    readonly costOutputPerMTok?: number;
    readonly supportsTools?: boolean;
    readonly contextLimit?: number;
}
export interface RouteDecision {
    readonly providerID: string;
    readonly modelID: string;
    /** Why this model (FR-043). */
    readonly reason: string;
    /** The fallback that would be used if this fails (FR-044), if any. */
    readonly fallback?: {
        providerID: string;
        modelID: string;
        reason: string;
    };
    /** Whether the choice was a manual pin (disables auto-routing). */
    readonly pinned: boolean;
}
export interface RouteRequest {
    readonly taskType: string;
    readonly requiresTools: boolean;
    /** Optional user pin: "provider/model". If set, auto-routing is bypassed (FR-043). */
    readonly pinnedModel?: string;
    /** Allowlist of "provider/model" entries. Empty/undefined = all discovered models allowed. */
    readonly allowlist?: readonly string[];
    /** Ordered preferred models (role preference), best first. */
    readonly preferred?: readonly string[];
    /** Whether a fallback may be used on failure (FR-044 policy). */
    readonly allowFallback: boolean;
}
export declare class ModelRouterError extends Error {
    constructor(message: string);
}
export declare class ModelRouter {
    private available;
    /** Replace the discovered model catalog (FR-040 — fed from ctx.model.list()). */
    setAvailable(models: readonly ModelCandidate[]): void;
    getAvailable(): readonly ModelCandidate[];
    /** Filter to the allowlist (FR-042). Empty allowlist → everything allowed. */
    private allowlisted;
    /** Choose a model for a task. Throws if nothing eligible (never guesses a model). */
    route(req: RouteRequest): RouteDecision;
    private decide;
    /** Pick a different model than `exclude` to serve as fallback (FR-044). */
    private pickFallback;
    /**
     * Record a runtime failure and switch to the fallback if policy allows (FR-044).
     * Returns the new decision and a loggable reason, or null if no fallback permitted.
     */
    onFailure(current: RouteDecision, error: string): {
        decision: RouteDecision;
        switched: true;
        reason: string;
    } | null;
}
