/**
 * Run / Task manager (SRS §5.2, §7.2, §8.2, §8.3, §8.4).
 *
 * Owns the lifecycle of Runs and Tasks: creation, DAG validation, state
 * transitions (persisted + journaled), readiness computation, and recovery
 * hooks. Domain logic depends only on `PersistenceAdapter` + `AgentRegistry`.
 *
 * Concurrency safety: a task's lease (FR-054) must be acquired before a worker
 * starts it; the manager exposes `acquireTaskLease` for that.
 */
import { type Run, type RunBudget, type RunFullState, type RunMode, type Task, type TaskLimits, type TaskState, type TaskType, type Priority, type AcceptanceCriterion } from "../domain/types.js";
import { AgentRegistry } from "../agents/registry.js";
import { Dag } from "../orchestration/dag.js";
import { type PersistenceAdapter, type RunRecord, type TaskRecord } from "../reliability/adapter.js";
export interface CreateTaskInput {
    readonly type: TaskType;
    readonly title: string;
    readonly description?: string;
    readonly priority?: Priority;
    readonly dependencies?: readonly string[];
    readonly assignedRole?: string;
    readonly inputArtifactIds?: readonly string[];
    readonly acceptanceCriteria?: readonly AcceptanceCriterion[];
    readonly limits?: Partial<TaskLimits>;
    readonly idempotencyKey?: string;
}
export interface CreateRunInput {
    readonly goal: string;
    readonly mode?: RunMode;
    readonly budget?: Partial<RunBudget>;
    readonly tasks?: readonly CreateTaskInput[];
}
declare function runToRecord(r: Run): RunRecord;
declare function recordToRun(rec: RunRecord): Run;
declare function taskToRecord(t: Task): TaskRecord;
declare function recordToTask(rec: TaskRecord): Task;
export declare class RunManager {
    private readonly db;
    private readonly registry;
    constructor(db: PersistenceAdapter, registry: AgentRegistry);
    /** Create a Run (optionally with an initial task set) and persist atomically. */
    createRun(input: CreateRunInput): Promise<Run>;
    getRun(id: string): Promise<Run | undefined>;
    listRuns(): Promise<Run[]>;
    listRunsByStatus(statuses: readonly RunFullState[]): Promise<Run[]>;
    /** Approvals recorded for a run (R4, FR-102). */
    listApprovals(runId: string): Promise<import("../reliability/adapter.js").ApprovalRecord[]>;
    getTasks(runId: string): Promise<Task[]>;
    getTask(id: string): Promise<Task | undefined>;
    /** Rebuild the DAG for a run from persisted tasks. */
    dagForRun(runId: string): Promise<Dag<{
        id: string;
        dependencies: readonly string[];
    }>>;
    /** Transition a Run to a new state, persist, and journal. Throws on illegal transition. */
    transitionRun(runId: string, to: RunFullState, reason?: string): Promise<Run>;
    /** Transition a Task to a new state, persist, journal, and update DAG readiness bookkeeping. */
    transitionTask(taskId: string, to: TaskState, reason?: string): Promise<Task>;
    /** Tasks in a run that are ready to be scheduled (DAG + status). */
    readyTasks(runId: string): Promise<Task[]>;
    /** Acquire a lease for a task before a worker starts it (FR-054). */
    acquireTaskLease(taskId: string, owner: string, ttlMs: number): Promise<boolean>;
    releaseTaskLease(taskId: string, owner: string): Promise<void>;
    /** Persist an already-mutated Task (escape hatch for orchestrator bookkeeping). */
    updateTask(task: Task): Promise<void>;
    assignRole(taskId: string, roleId: string): Promise<Task>;
    /** Select a role for a task using the registry (lowest-risk suitable). */
    selectRoleForTask(task: Task, preferredRoleId?: string): string;
    /** Run-level progress summary (SRS §5.2). */
    progress(runId: string): Promise<{
        run: Run;
        tasks: Task[];
        dag: {
            total: number;
            succeeded: number;
            failed: number;
            skipped: number;
            running: number;
            pending: number;
            percent: number;
        };
    }>;
}
export { recordToRun, recordToTask, runToRecord, taskToRecord };
