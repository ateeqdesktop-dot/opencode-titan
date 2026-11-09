/**
 * Persistence adapter interface (ADR-004).
 * Domain/orchestration logic depends ONLY on this — never on a concrete DB driver.
 *
 * SRS §8.4/§8.5: schemaVersion + migrations, transactions, atomic state changes,
 * append-only event journal, indexes, backup, corruption handling, retention.
 */

// ── Records ──────────────────────────────────────────────────────────────────
export interface RunRecord {
  id: string
  goal: string
  status: string
  mode: string
  budget: string // JSON
  statusReason?: string
  createdAt: number
  updatedAt: number
  closedAt?: number
}

export interface TaskRecord {
  id: string
  runId: string
  type: string
  title: string
  description?: string
  status: string
  priority: string
  dependencies: string // JSON array
  assignedRole?: string
  assignedSessionId?: string
  workspaceId?: string
  inputArtifactIds: string // JSON array
  acceptanceCriteria: string // JSON array
  limits: string // JSON
  idempotencyKey: string
  attempts: number
  evidence: string // JSON array
  createdAt: number
  updatedAt: number
}

export interface EventRecord {
  seq: number
  type: string
  runId?: string
  taskId?: string
  agentRunId?: string
  correlationId?: string
  schemaVersion: number
  payload: string // JSON
  at: number
}

export interface ApprovalRecord {
  id: string
  runId: string
  taskId?: string
  action: string
  resource: string
  requestedBy: string
  reason: string
  status: string
  decidedBy?: string
  decidedAt?: number
  expiresAt?: number
}

export interface BudgetRecord {
  runId: string
  maxConcurrentWorkers: number
  maxAttemptsPerTask: number
  maxTotalSeconds: number
  maxEstimatedCostUsd?: number
  maxModelCalls?: number
  usedModelCalls: number
  usedEstimatedCostUsd: number
  startedAt: number
  updatedAt: number
}

export interface LeaseRecord {
  taskId: string
  owner: string // agentRunId
  acquiredAt: number
  expiresAt: number
}

export interface AgentRunRecord {
  id: string
  runId: string
  taskId: string
  role: string
  sessionId?: string
  status: string
  workspaceId?: string
  model?: string
  createdAt: number
  updatedAt: number
}

// ── Adapter interface ────────────────────────────────────────────────────────
export interface PersistenceAdapter {
  readonly driver: "bun-sqlite" | "node-sqlite" | "json-fallback"
  readonly schemaVersion: number

  init(): Promise<void>
  close(): Promise<void>

  // Runs
  putRun(run: RunRecord): Promise<void>
  getRun(id: string): Promise<RunRecord | undefined>
  listRuns(): Promise<RunRecord[]>
  listRunsByStatus(statuses: readonly string[]): Promise<RunRecord[]>

  // Tasks
  putTask(task: TaskRecord): Promise<void>
  getTask(id: string): Promise<TaskRecord | undefined>
  listTasksByRun(runId: string): Promise<TaskRecord[]>
  listTasksByStatus(statuses: readonly string[]): Promise<TaskRecord[]>

  // Event journal (append-only, sequenced, deduped) — FR-091
  appendEvent(evt: Omit<EventRecord, "seq">): Promise<EventRecord>
  listEvents(filter?: { runId?: string; sinceSeq?: number; limit?: number }): Promise<EventRecord[]>
  lastSeq(): Promise<number>

  // Approvals — FR-102/NFR-024
  putApproval(a: ApprovalRecord): Promise<void>
  getApproval(id: string): Promise<ApprovalRecord | undefined>
  listApprovalsByRun(runId: string): Promise<ApprovalRecord[]>
  listPendingApprovals(): Promise<ApprovalRecord[]>

  // Budget
  putBudget(b: BudgetRecord): Promise<void>
  getBudget(runId: string): Promise<BudgetRecord | undefined>
  updateBudget(runId: string, patch: Partial<BudgetRecord>): Promise<void>

  // Leases — FR-054
  acquireLease(taskId: string, owner: string, ttlMs: number): Promise<boolean>
  releaseLease(taskId: string, owner: string): Promise<void>
  getLease(taskId: string): Promise<LeaseRecord | undefined>
  expireLeases(now: number): Promise<number>

  // Agent runs
  putAgentRun(a: AgentRunRecord): Promise<void>
  getAgentRun(id: string): Promise<AgentRunRecord | undefined>
  listAgentRunsByRun(runId: string): Promise<AgentRunRecord[]>
  findAgentRunBySession(sessionId: string): Promise<AgentRunRecord | undefined>

  // Retention / maintenance — FR-090, §8.4
  purgeRunsOlderThan(cutoffMs: number): Promise<number>
  verifyIntegrity(): Promise<{ ok: boolean; issues: string[] }>
}

// ── Schema versioning ────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 1

export class StorageError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = "StorageError"
  }
}
