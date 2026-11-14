/**
 * SQLite persistence adapter (ADR-004, SRS §8.5).
 *
 * Detects the available SQLite driver at runtime:
 *   - `bun:sqlite`  (OpenCode server runs on Bun — primary)
 *   - `node:sqlite` (fallback when hosted on Node)
 *   - JSON fallback (last resort; documented limitation: no cross-row transactions)
 *
 * Domain code never touches these drivers directly — only `PersistenceAdapter`.
 * Includes schema versioning, migrations, transactions, and an append-only event journal.
 */
import { type AgentRunRecord, type ApprovalRecord, type BudgetRecord, type EventRecord, type LeaseRecord, type PersistenceAdapter, type RunRecord, type TaskRecord } from "./adapter.js";
export declare class SqliteAdapter implements PersistenceAdapter {
    readonly driver: "bun-sqlite" | "node-sqlite" | "json-fallback";
    readonly schemaVersion = 1;
    private db;
    private readonly kind;
    private constructor();
    /**
     * Open the adapter, selecting the best available driver.
     * - `file: ":memory:"` (default when omitted) → ephemeral, used by unit tests.
     * - `file: "<path>"` → durable, survives restarts (SRS FR-090; required for
     *   recovery after OpenCode restarts). The parent directory is created.
     */
    static open(opts?: {
        readonly file?: string | null;
    }): Promise<SqliteAdapter>;
    init(): Promise<void>;
    private migrate;
    close(): Promise<void>;
    private req;
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
