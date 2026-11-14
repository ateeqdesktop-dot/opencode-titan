/**
 * Secret hygiene (SRS §11 security, SEC IDs).
 *
 * TITAN persists prompts, task briefs, evidence and journal payloads. Anything
 * that looks like a credential must never reach durable state in plaintext —
 * even in a fully local install. This module is PURE: pattern detection +
 * masked replacement, unit-tested, used by the executor and journal writers.
 */
export interface SecretFinding {
    readonly kind: string;
    readonly masked: string;
}
export declare function findSecrets(text: string): readonly string[];
/** Replace every detected secret with a stable mask; keeps surrounding text readable. */
export declare function redactSecrets(text: string): string;
/** Redact + classify in one pass, for evidence/journal writes. */
export declare function sanitizeForStore(text: string): {
    readonly text: string;
    readonly secrets: readonly string[];
};
