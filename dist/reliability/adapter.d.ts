/**
 * Persistence adapter interface (ADR-004).
 * Domain/orchestration logic depends ONLY on this — never on a concrete DB driver.
 *
 * SRS §8.4/§8.5: schemaVersion + migrations, transactions, atomic state changes,
 * append-only event journal, indexes, backup, corruption handling, retention.
 */
export interface RunRecord {
    id: string;
    goal: string;
    status: string;
    mode: string;
    budget: string;
    statusReason?: string;
    createdAt: number;
    updatedAt: number;
    closedAt?: number;
}
export interface TaskRecord {
    id: string;
    runId: string;
    type: string;
    title: string;
    description?: string;
    status: string;
    priority: string;
    dependencies: string;
    assignedRole?: string;
    assignedSessionId?: string;
    workspaceId?: string;
    inputArtifactIds: string;
    acceptanceCriteria: string;
    limits: string;
    idempotencyKey: string;
    attempts: number;
    evidence: string;
    createdAt: number;
    updatedAt: number;
}
export interface EventRecord {
    seq: number;
    type: string;
    runId?: string;
    taskId?: string;
    agentRunId?: string;
    correlationId?: string;
    schemaVersion: number;
    payload: string;
    at: number;
}
export interface ApprovalRecord {
    id: string;
    runId: string;
    taskId?: string;
    action: string;
    resource: string;
    requestedBy: string;
    reason: string;
    status: string;
    decidedBy?: string;
    decidedAt?: number;
    expiresAt?: number;
}
export interface BudgetRecord {
    runId: string;
    maxConcurrentWorkers: number;
    maxAttemptsPerTask: number;
    maxTotalSeconds: number;
    maxEstimatedCostUsd?: number;
    maxModelCalls?: number;
    usedModelCalls: number;
    usedEstimatedCostUsd: number;
    startedAt: number;
    updatedAt: number;
}
export interface LeaseRecord {
    taskId: string;
    owner: string;
    acquiredAt: number;
    expiresAt: number;
}
export interface AgentRunRecord {
    id: string;
    runId: string;
    taskId: string;
    role: string;
    sessionId?: string;
    status: string;
    workspaceId?: string;
    model?: string;
    createdAt: number;
    updatedAt: number;
}
export interface PersistenceAdapter {
    readonly driver: "bun-sqlite" | "node-sqlite" | "json-fallback";
    readonly schemaVersion: number;
    init(): Promise<void>;
    close(): Promise<void>;
    putRun(run: RunRecord): Promise<void>;
    getRun(id: string): Promise<RunRecord | undefined>;
    listRuns(): Promise<RunRecord[]>;
    listRunsByStatus(statuses: readonly string[]): Promise<RunRecord[]>;
    putTask(task: TaskRecord): Promise<void>;
    getTask(id: string): Promise<TaskRecord | undefined>;
    listTasksByRun(runId: string): Promise<TaskRecord[]>;
    listTasksByStatus(statuses: readonly string[]): Promise<TaskRecord[]>;
    appendEvent(evt: Omit<EventRecord, "seq">): Promise<EventRecord>;
    listEvents(filter?: {
        runId?: string;
        sinceSeq?: number;
        limit?: number;
    }): Promise<EventRecord[]>;
    lastSeq(): Promise<number>;
    putApproval(a: ApprovalRecord): Promise<void>;
    getApproval(id: string): Promise<ApprovalRecord | undefined>;
    listApprovalsByRun(runId: string): Promise<ApprovalRecord[]>;
    listPendingApprovals(): Promise<ApprovalRecord[]>;
    putBudget(b: BudgetRecord): Promise<void>;
    getBudget(runId: string): Promise<BudgetRecord | undefined>;
    updateBudget(runId: string, patch: Partial<BudgetRecord>): Promise<void>;
    acquireLease(taskId: string, owner: string, ttlMs: number): Promise<boolean>;
    releaseLease(taskId: string, owner: string): Promise<void>;
    getLease(taskId: string): Promise<LeaseRecord | undefined>;
    expireLeases(now: number): Promise<number>;
    putAgentRun(a: AgentRunRecord): Promise<void>;
    getAgentRun(id: string): Promise<AgentRunRecord | undefined>;
    listAgentRunsByRun(runId: string): Promise<AgentRunRecord[]>;
    findAgentRunBySession(sessionId: string): Promise<AgentRunRecord | undefined>;
    purgeRunsOlderThan(cutoffMs: number): Promise<number>;
    verifyIntegrity(): Promise<{
        ok: boolean;
        issues: string[];
    }>;
}
export declare const SCHEMA_VERSION = 1;
export declare class StorageError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
