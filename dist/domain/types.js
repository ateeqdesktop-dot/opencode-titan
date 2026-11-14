/**
 * TITAN domain types — shared contracts.
 * SRS §8 (data & state), Appendix A (task contract).
 * TypeScript strict; no `any`.
 */
// ── Run state machine (SRS §8.2) ─────────────────────────────────────────────
export const RUN_STATES = [
    "CREATED",
    "PREFLIGHT",
    "ANALYZING",
    "PLANNING",
    "AWAITING_APPROVAL",
    "READY",
    "RUNNING",
    "VERIFYING",
    "REPAIRING",
    "PAUSED",
    "NEEDS_HUMAN",
    "SUCCEEDED",
    "FAILED",
    "REJECTED",
    "CANCELLED",
    "CLOSED",
];
/** Allowed next-state transitions for a Run (SRS §8.2). Terminal: CLOSED. */
export const RUN_TRANSITIONS = {
    CREATED: ["PREFLIGHT", "CANCELLED"],
    PREFLIGHT: ["ANALYZING", "BLOCKED", "FAILED"],
    ANALYZING: ["PLANNING", "NEEDS_INPUT"],
    PLANNING: ["AWAITING_APPROVAL", "READY"],
    AWAITING_APPROVAL: ["READY", "REJECTED", "CANCELLED"],
    READY: ["RUNNING", "CANCELLED"],
    RUNNING: ["VERIFYING", "PAUSED", "NEEDS_INPUT", "FAILED"],
    VERIFYING: ["REPAIRING", "SUCCEEDED", "BLOCKED"],
    REPAIRING: ["VERIFYING", "NEEDS_HUMAN", "FAILED"],
    PAUSED: ["READY", "RUNNING", "CANCELLED"],
    NEEDS_HUMAN: ["RUNNING", "CANCELLED", "WAIVED"],
    SUCCEEDED: ["CLOSED"],
    FAILED: ["CLOSED"],
    REJECTED: ["CLOSED"],
    CANCELLED: ["CLOSED"],
    CLOSED: [],
    // Auxiliary states named as destinations in SRS §8.2. Their outgoing edges are chosen
    // for safe resumption (documented in ADR-005): unblock/resume, or terminate safely.
    BLOCKED: ["READY", "RUNNING", "CANCELLED", "FAILED"],
    NEEDS_INPUT: ["PLANNING", "READY", "CANCELLED"],
    WAIVED: ["READY", "RUNNING", "CLOSED"],
};
// ── Task state machine (SRS §8.3) ────────────────────────────────────────────
export const TASK_STATES = [
    "DRAFT",
    "BLOCKED",
    "READY",
    "QUEUED",
    "RUNNING",
    "WAITING_APPROVAL",
    "VERIFYING",
    "NEEDS_REWORK",
    "SUCCEEDED",
    "FAILED",
    "CANCELLED",
    "SKIPPED",
];
/**
 * Allowed Task transitions. Enforces the SRS rule: FAILED never jumps to SUCCEEDED
 * without a re-run (it must go FAILED -> QUEUED/RUNNING via rework, or to a terminal
 * non-success state). SKIPPED is terminal-ish and never used to hide a failure.
 */
export const TASK_TRANSITIONS = {
    // DRAFT/BLOCKED/READY tasks may be SKIPPED before they ever start (e.g. an
    // upstream dependency failed); a task that already started may not.
    DRAFT: ["READY", "BLOCKED", "CANCELLED", "SKIPPED"],
    BLOCKED: ["READY", "CANCELLED", "SKIPPED"],
    READY: ["QUEUED", "CANCELLED", "SKIPPED"],
    QUEUED: ["RUNNING", "CANCELLED"],
    RUNNING: ["VERIFYING", "WAITING_APPROVAL", "FAILED", "CANCELLED", "BLOCKED"],
    WAITING_APPROVAL: ["RUNNING", "FAILED", "CANCELLED", "BLOCKED"],
    VERIFYING: ["SUCCEEDED", "NEEDS_REWORK", "FAILED"],
    NEEDS_REWORK: ["QUEUED", "FAILED", "CANCELLED"],
    SUCCEEDED: [],
    FAILED: ["NEEDS_REWORK", "CANCELLED"], // re-run only via rework; never straight to SUCCEEDED
    CANCELLED: [],
    SKIPPED: [],
};
// ── Priority ─────────────────────────────────────────────────────────────────
export const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export const TASK_TYPES = [
    "exploration",
    "requirements",
    "planning",
    "implementation",
    "test",
    "review",
    "security",
    "integration",
    "documentation",
    "repair",
];
export const RUN_MODES = [
    "direct",
    "plan",
    "supervised",
    "bounded-autonomous",
    "review-only",
];
// ── Verification gates (SRS §13.2, FR-087) ───────────────────────────────────
export const GATE_STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "WAIVED"];
export const GATE_KINDS = [
    "scope",
    "build",
    "type-lint",
    "test",
    "review",
    "security",
    "acceptance",
    "delivery",
];
// ── Error classification (SRS §12.1) ────────────────────────────────────────
export const ERROR_CLASSES = [
    "validation",
    "config",
    "permission",
    "provider",
    "rate-limit",
    "network",
    "session",
    "task-execution",
    "test-failure",
    "merge-conflict",
    "storage",
    "recovery",
    "internal",
];
/** Whether an error class is safe to auto-retry (SRS §12.1). */
export function isRetryable(cls) {
    switch (cls) {
        case "rate-limit":
        case "network":
        case "provider":
        case "session":
        case "task-execution":
        case "test-failure":
            return true;
        // Never auto-retry: schema/permission/path/config — retrying would bypass policy.
        case "validation":
        case "config":
        case "permission":
        case "merge-conflict":
        case "storage":
        case "recovery":
        case "internal":
            return false;
    }
}
