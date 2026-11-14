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
/** Minimum OpenCode version TITAN supports (SRS FR-002). */
export const MIN_OPENCODE_VERSION = "2.0.0";
/** Parse a semver-ish "x.y.z" string; returns null if unparseable. */
export function parseVersion(v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    if (!m)
        return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
/** True when `actual` >= `required` (semver-ish, ignores pre-release tags). */
export function versionGte(actual, required) {
    const a = parseVersion(actual);
    const b = parseVersion(required);
    if (!a || !b)
        return false;
    if (a.major !== b.major)
        return a.major > b.major;
    if (a.minor !== b.minor)
        return a.minor > b.minor;
    return a.patch >= b.patch;
}
/** Run every diagnostic and produce an ordered report. `sessionID` (when known) scopes permission checks. */
export async function runDoctor(src, opts) {
    const sessionID = opts?.sessionID;
    const checks = [];
    // 1) OpenCode version compatibility (FR-002)
    const version = src.appVersion();
    const supported = versionGte(version, MIN_OPENCODE_VERSION);
    checks.push({
        id: "opencode-version",
        label: "OpenCode version",
        status: supported ? "PASS" : "FAIL",
        detail: `running ${version}, requires >= ${MIN_OPENCODE_VERSION}${supported ? "" : " — TITAN cannot run in unsupported mode"}`,
    });
    // 2) Plugin registration (FR-001/FR-003)
    checks.push({
        id: "plugin-loaded",
        label: "Plugin registration",
        status: "PASS",
        detail: `id=${src.pluginId()} (reached doctor, so setup succeeded)`,
    });
    // 3) Project location / config (FR-007)
    const loc = src.location();
    checks.push({
        id: "location",
        label: "Project location",
        status: loc.directory ? "PASS" : "FAIL",
        detail: `directory=${loc.directory || "(none)"} project=${loc.project ?? "(global)"}`,
    });
    // 4) Models (FR-007/FR-040)
    try {
        const models = await src.models();
        const free = models.filter((m) => m.modelID.endsWith("-free")).length;
        checks.push({
            id: "models",
            label: "Available models",
            status: models.length > 0 ? "PASS" : "FAIL",
            detail: `${models.length} model(s) discovered${models.length === 0 ? " — no model routing possible" : `, ${free} free`}`,
        });
    }
    catch (e) {
        checks.push({ id: "models", label: "Available models", status: "FAIL", detail: String(e) });
    }
    // 5) Storage (FR-090, ADR-004)
    try {
        const ok = await src.storageProbe();
        checks.push({
            id: "storage",
            label: "Durable storage",
            status: ok ? "PASS" : "FAIL",
            detail: ok ? "write/read round-trip OK" : "write/read round-trip FAILED",
        });
    }
    catch (e) {
        checks.push({ id: "storage", label: "Durable storage", status: "FAIL", detail: String(e) });
    }
    // 6) Git / VCS (verification evidence source)
    try {
        const branch = await src.vcsBranch();
        const changed = await src.vcsChangedFiles();
        checks.push({
            id: "vcs",
            label: "Version control",
            status: branch ? "PASS" : "WARN",
            detail: branch
                ? `branch=${branch} (${changed} changed file(s))`
                : `no branch detected (${changed} changed file(s)) — verification evidence may be limited`,
        });
    }
    catch (e) {
        checks.push({ id: "vcs", label: "Version control", status: "WARN", detail: String(e) });
    }
    // 7) Permissions (NFR-024)
    try {
        const n = await src.permissionRuleCount(sessionID);
        checks.push({
            id: "permissions",
            label: "Permission rules",
            status: "PASS",
            detail: `${n} rule(s) configured`,
        });
    }
    catch (e) {
        checks.push({ id: "permissions", label: "Permission rules", status: "WARN", detail: String(e) });
    }
    return checks;
}
/** Overall verdict: FAIL if any FAIL, WARN if any WARN, else PASS. */
export function verdict(checks) {
    if (checks.some((c) => c.status === "FAIL"))
        return "FAIL";
    if (checks.some((c) => c.status === "WARN"))
        return "WARN";
    return "PASS";
}
/** Render the report as plain text (used by `/titan doctor`). */
export function renderDoctor(checks) {
    const v = verdict(checks);
    const icon = (s) => (s === "PASS" ? "✔" : s === "WARN" ? "⚠" : "✘");
    const lines = [
        `TITAN doctor — ${v}`,
        "",
        ...checks.map((c) => `  ${icon(c.status)} ${c.label}: ${c.status} — ${c.detail}`),
        "",
        `Overall: ${v}`,
    ];
    return lines.join("\n");
}
