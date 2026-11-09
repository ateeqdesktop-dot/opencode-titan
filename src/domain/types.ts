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
] as const
export type RunState = (typeof RUN_STATES)[number]

/** Allowed next-state transitions for a Run (SRS §8.2). Terminal: CLOSED. */
export const RUN_TRANSITIONS: Readonly<Record<RunFullState, readonly RunFullState[]>> = {
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
}

// Extra states the SRS references but are not in the base list — modelled explicitly
// so transitions stay exhaustive and typed.
export type RunAuxState = "BLOCKED" | "NEEDS_INPUT" | "WAIVED"
export type RunFullState = RunState | RunAuxState

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
] as const
export type TaskState = (typeof TASK_STATES)[number]

/**
 * Allowed Task transitions. Enforces the SRS rule: FAILED never jumps to SUCCEEDED
 * without a re-run (it must go FAILED -> QUEUED/RUNNING via rework, or to a terminal
 * non-success state). SKIPPED is terminal-ish and never used to hide a failure.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
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
}

// ── Priority ─────────────────────────────────────────────────────────────────
export const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const
export type Priority = (typeof PRIORITIES)[number]

// ── Acceptance criteria ──────────────────────────────────────────────────────
export interface AcceptanceCriterion {
  readonly id: string
  readonly statement: string
  readonly evidenceRequired: boolean
}

// ── Task contract (SRS Appendix A) ───────────────────────────────────────────
export interface TaskLimits {
  readonly maxAttempts: number
  readonly timeoutSeconds: number
}

export interface Task {
  readonly schemaVersion: 1
  readonly id: string
  readonly runId: string
  readonly type: TaskType
  readonly title: string
  readonly description?: string
  status: TaskState
  priority: Priority
  readonly dependencies: readonly string[]
  assignedRole?: string
  assignedSessionId?: string
  workspaceId?: string
  readonly inputArtifactIds: readonly string[]
  readonly acceptanceCriteria: readonly AcceptanceCriterion[]
  readonly limits: TaskLimits
  readonly idempotencyKey: string
  attempts: number
  // evidence + timestamps
  evidence: readonly Evidence[]
  createdAt: number
  updatedAt: number
}

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
] as const
export type TaskType = (typeof TASK_TYPES)[number]

// ── Evidence (SRS §1.4) — inspectable proof ──────────────────────────────────
export interface Evidence {
  readonly kind:
    | "diff"
    | "test"
    | "typecheck"
    | "lint"
    | "build"
    | "review"
    | "log"
    | "artifact"
    | "command"
  readonly ref: string
  readonly summary: string
  readonly ok?: boolean
  readonly at: number
}

// ── Run ──────────────────────────────────────────────────────────────────────
export interface RunBudget {
  readonly maxConcurrentWorkers: number
  readonly maxAttemptsPerTask: number
  readonly maxTotalSeconds: number
  readonly maxEstimatedCostUsd?: number
  readonly maxModelCalls?: number
}

export interface Run {
  readonly schemaVersion: 1
  readonly id: string
  readonly goal: string
  status: RunFullState
  mode: RunMode
  budget: RunBudget
  readonly createdAt: number
  updatedAt: number
  closedAt?: number
  /** Reason captured for BLOCKED / NEEDS_HUMAN / FAILED / WAIVED. */
  statusReason?: string
}

export const RUN_MODES = [
  "direct",
  "plan",
  "supervised",
  "bounded-autonomous",
  "review-only",
] as const
export type RunMode = (typeof RUN_MODES)[number]

// ── Agent role (SRS §5.3, FR-030) ────────────────────────────────────────────
export interface RoleLimits {
  readonly maxAttempts: number
  readonly timeoutSeconds: number
  readonly maxCostUsd?: number
}

export interface AgentRole {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly objective: string
  readonly skills: readonly string[]
  readonly suitableTaskTypes: readonly TaskType[]
  readonly requiredInputs: readonly string[]
  readonly expectedOutputs: readonly string[]
  readonly preferredModel?: string
  readonly fallbackModels: readonly string[]
  readonly allowedTools: readonly string[]
  readonly deniedTools: readonly string[]
  readonly access: "read-only" | "read-write" | "admin"
  readonly riskLevel: "low" | "medium" | "high"
  readonly limits: RoleLimits
  readonly workspacePolicy: "shared-read" | "isolated-write" | "any"
}

// ── Verification gates (SRS §13.2, FR-087) ───────────────────────────────────
export const GATE_STATUSES = ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "WAIVED"] as const
export type GateStatus = (typeof GATE_STATUSES)[number]

export const GATE_KINDS = [
  "scope",
  "build",
  "type-lint",
  "test",
  "review",
  "security",
  "acceptance",
  "delivery",
] as const
export type GateKind = (typeof GATE_KINDS)[number]

export interface Gate {
  readonly kind: GateKind
  status: GateStatus
  /** MUST NOT convert NOT_RUN -> PASS. */
  evidence?: Evidence[]
  reason?: string
}

// ── Approval (SRS §11.3, NFR-024) ───────────────────────────────────────────
export interface Approval {
  readonly id: string
  readonly runId: string
  readonly taskId?: string
  /** The exact action being approved — approvals are action+resource scoped (NFR-024). */
  readonly action: string
  readonly resource: string
  readonly requestedBy: string
  readonly reason: string
  status: "pending" | "approved" | "rejected"
  decidedBy?: string
  decidedAt?: number
  /** Approvals expire; they do not carry over to a different action. */
  expiresAt?: number
}

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
] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]

/** Whether an error class is safe to auto-retry (SRS §12.1). */
export function isRetryable(cls: ErrorClass): boolean {
  switch (cls) {
    case "rate-limit":
    case "network":
    case "provider":
    case "session":
    case "task-execution":
    case "test-failure":
      return true
    // Never auto-retry: schema/permission/path/config — retrying would bypass policy.
    case "validation":
    case "config":
    case "permission":
    case "merge-conflict":
    case "storage":
    case "recovery":
    case "internal":
      return false
  }
}
