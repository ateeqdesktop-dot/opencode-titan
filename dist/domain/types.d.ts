/**
 * TITAN domain types — shared contracts.
 * SRS §8 (data & state), Appendix A (task contract).
 * TypeScript strict; no `any`.
 */
export declare const RUN_STATES: readonly ["CREATED", "PREFLIGHT", "ANALYZING", "PLANNING", "AWAITING_APPROVAL", "READY", "RUNNING", "VERIFYING", "REPAIRING", "PAUSED", "NEEDS_HUMAN", "SUCCEEDED", "FAILED", "REJECTED", "CANCELLED", "CLOSED"];
export type RunState = (typeof RUN_STATES)[number];
/** Allowed next-state transitions for a Run (SRS §8.2). Terminal: CLOSED. */
export declare const RUN_TRANSITIONS: Readonly<Record<RunFullState, readonly RunFullState[]>>;
export type RunAuxState = "BLOCKED" | "NEEDS_INPUT" | "WAIVED";
export type RunFullState = RunState | RunAuxState;
export declare const TASK_STATES: readonly ["DRAFT", "BLOCKED", "READY", "QUEUED", "RUNNING", "WAITING_APPROVAL", "VERIFYING", "NEEDS_REWORK", "SUCCEEDED", "FAILED", "CANCELLED", "SKIPPED"];
export type TaskState = (typeof TASK_STATES)[number];
/**
 * Allowed Task transitions. Enforces the SRS rule: FAILED never jumps to SUCCEEDED
 * without a re-run (it must go FAILED -> QUEUED/RUNNING via rework, or to a terminal
 * non-success state). SKIPPED is terminal-ish and never used to hide a failure.
 */
export declare const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>>;
export declare const PRIORITIES: readonly ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
export type Priority = (typeof PRIORITIES)[number];
export interface AcceptanceCriterion {
    readonly id: string;
    readonly statement: string;
    readonly evidenceRequired: boolean;
}
export interface TaskLimits {
    readonly maxAttempts: number;
    readonly timeoutSeconds: number;
}
export interface Task {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly runId: string;
    readonly type: TaskType;
    readonly title: string;
    readonly description?: string;
    status: TaskState;
    priority: Priority;
    readonly dependencies: readonly string[];
    assignedRole?: string;
    assignedSessionId?: string;
    workspaceId?: string;
    readonly inputArtifactIds: readonly string[];
    readonly acceptanceCriteria: readonly AcceptanceCriterion[];
    readonly limits: TaskLimits;
    readonly idempotencyKey: string;
    attempts: number;
    evidence: readonly Evidence[];
    createdAt: number;
    updatedAt: number;
}
export declare const TASK_TYPES: readonly ["exploration", "requirements", "planning", "implementation", "test", "review", "security", "integration", "documentation", "repair"];
export type TaskType = (typeof TASK_TYPES)[number];
export interface Evidence {
    readonly kind: "diff" | "test" | "typecheck" | "lint" | "build" | "review" | "log" | "artifact" | "command";
    readonly ref: string;
    readonly summary: string;
    readonly ok?: boolean;
    readonly at: number;
}
export interface RunBudget {
    readonly maxConcurrentWorkers: number;
    readonly maxAttemptsPerTask: number;
    readonly maxTotalSeconds: number;
    readonly maxEstimatedCostUsd?: number;
    readonly maxModelCalls?: number;
}
export interface Run {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly goal: string;
    status: RunFullState;
    mode: RunMode;
    budget: RunBudget;
    readonly createdAt: number;
    updatedAt: number;
    closedAt?: number;
    /** Reason captured for BLOCKED / NEEDS_HUMAN / FAILED / WAIVED. */
    statusReason?: string;
}
export declare const RUN_MODES: readonly ["direct", "plan", "supervised", "bounded-autonomous", "review-only"];
export type RunMode = (typeof RUN_MODES)[number];
export interface RoleLimits {
    readonly maxAttempts: number;
    readonly timeoutSeconds: number;
    readonly maxCostUsd?: number;
}
export interface AgentRole {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly objective: string;
    readonly skills: readonly string[];
    readonly suitableTaskTypes: readonly TaskType[];
    readonly requiredInputs: readonly string[];
    readonly expectedOutputs: readonly string[];
    readonly preferredModel?: string;
    readonly fallbackModels: readonly string[];
    readonly allowedTools: readonly string[];
    readonly deniedTools: readonly string[];
    readonly access: "read-only" | "read-write" | "admin";
    readonly riskLevel: "low" | "medium" | "high";
    readonly limits: RoleLimits;
    readonly workspacePolicy: "shared-read" | "isolated-write" | "any";
}
export declare const GATE_STATUSES: readonly ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "WAIVED"];
export type GateStatus = (typeof GATE_STATUSES)[number];
export declare const GATE_KINDS: readonly ["scope", "build", "type-lint", "test", "review", "security", "acceptance", "delivery"];
export type GateKind = (typeof GATE_KINDS)[number];
export interface Gate {
    readonly kind: GateKind;
    status: GateStatus;
    /** MUST NOT convert NOT_RUN -> PASS. */
    evidence?: Evidence[];
    reason?: string;
}
export interface Approval {
    readonly id: string;
    readonly runId: string;
    readonly taskId?: string;
    /** The exact action being approved — approvals are action+resource scoped (NFR-024). */
    readonly action: string;
    readonly resource: string;
    readonly requestedBy: string;
    readonly reason: string;
    status: "pending" | "approved" | "rejected";
    decidedBy?: string;
    decidedAt?: number;
    /** Approvals expire; they do not carry over to a different action. */
    expiresAt?: number;
}
export declare const ERROR_CLASSES: readonly ["validation", "config", "permission", "provider", "rate-limit", "network", "session", "task-execution", "test-failure", "merge-conflict", "storage", "recovery", "internal"];
export type ErrorClass = (typeof ERROR_CLASSES)[number];
/** Whether an error class is safe to auto-retry (SRS §12.1). */
export declare function isRetryable(cls: ErrorClass): boolean;
