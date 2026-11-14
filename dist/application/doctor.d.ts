/**
 * `/titan doctor` (SRS FR-007).
 *
 * Diagnoses: config, OpenCode version compatibility, available models, storage,
 * git/VCS state, and permission rules. Must not hide a failure — every check
 * reports PASS / WARN / FAIL with a detail string (FR-002: no silent continuation
 * in an unsupported mode).
 *
 * The doctor depends only on the `DoctorSources` interface so it can be unit-tested
 * without a live OpenCode server; the plugin entry binds the real `ctx`.
 */
export type CheckStatus = "PASS" | "WARN" | "FAIL";
export interface DoctorCheck {
    readonly id: string;
    readonly label: string;
    readonly status: CheckStatus;
    readonly detail: string;
}
/**
 * The live surfaces the doctor inspects. Bound from `ctx` in the plugin entry;
 * faked only in tests (never in the production path).
 */
export interface DoctorSources {
    /** OpenCode app version string (ctx.app.version). */
    appVersion(): string;
    /** Plugin's own id, for the report header. */
    pluginId(): string;
    /** `{ id, directory }` of the active location (ctx.location). */
    location(): {
        directory: string;
        project?: string;
    };
    /** Discovered models (ctx.model.list().data). */
    models(): Promise<{
        providerID: string;
        modelID: string;
    }[]>;
    /** Storage round-trip probe (ctx.storage set/get). */
    storageProbe(): Promise<boolean>;
    /** Current VCS branch or null when not a repo (ctx.vcs.get()). */
    vcsBranch(): Promise<string | null>;
    /** Changed file count (ctx.vcs.status().data). */
    vcsChangedFiles(): Promise<number>;
    /** Permission rules count (ctx.permission.list({sessionID})); returns bare array. */
    permissionRuleCount(sessionID?: string): Promise<number>;
}
/** Minimum OpenCode version TITAN supports (SRS FR-002). */
export declare const MIN_OPENCODE_VERSION = "2.0.0";
/** Parse a semver-ish "x.y.z" string; returns null if unparseable. */
export declare function parseVersion(v: string): {
    major: number;
    minor: number;
    patch: number;
} | null;
/** True when `actual` >= `required` (semver-ish, ignores pre-release tags). */
export declare function versionGte(actual: string, required: string): boolean;
/** Run every diagnostic and produce an ordered report. `sessionID` (when known) scopes permission checks. */
export declare function runDoctor(src: DoctorSources, opts?: {
    sessionID?: string;
}): Promise<DoctorCheck[]>;
/** Overall verdict: FAIL if any FAIL, WARN if any WARN, else PASS. */
export declare function verdict(checks: readonly DoctorCheck[]): CheckStatus;
/** Render the report as plain text (used by `/titan doctor`). */
export declare function renderDoctor(checks: readonly DoctorCheck[]): string;
