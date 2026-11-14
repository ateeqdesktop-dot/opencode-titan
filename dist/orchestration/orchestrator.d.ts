/**
 * Orchestrator (SRS §5.2, §7.2, §7.3, FR-050..FR-056, FR-060..FR-074).
 *
 * Drives a Run to completion:
 *  - schedules ready tasks up to maxWorkers concurrency (FR-050, NFR-004)
 *  - acquires leases before starting a task (FR-054)
 *  - assigns a role per task type, routes a model (FR-030/040)
 *  - isolates writes in a worktree when policy requires (FR-060)
 *  - executes via an injected `TaskExecutor` (real impl uses OpenCode sessions)
 *  - propagates failure to dependents (DAG)
 *  - honours pause/cancel/budget limits
 *  - emits progress events via the journal
 *
 * The orchestrator never blocks setup; it is driven by `run()` which returns
 * a promise the caller may await (command/RPC) or fire-and-forget.
 */
import { RunManager } from "../application/run-manager.js";
import { type PersistenceAdapter } from "../reliability/adapter.js";
import { ModelRouter, type RouteDecision } from "../agents/router.js";
import { AgentRegistry } from "../agents/registry.js";
import { type Run, type Task, type TaskState, type RunFullState, type ErrorClass } from "../domain/types.js";
export interface TaskExecutionContext {
    readonly run: Run;
    readonly task: Task;
    readonly role: string;
    readonly model: RouteDecision;
    readonly workspaceDir?: string;
    readonly signal: AbortSignal;
}
export interface TaskExecutionResult {
    readonly ok: boolean;
    readonly evidence: {
        kind: "diff" | "test" | "log" | "artifact" | "command";
        ref: string;
        summary: string;
        ok?: boolean;
    }[];
    readonly errorClass?: ErrorClass;
    readonly errorMessage?: string;
    readonly costUsd?: number;
    readonly modelCalls?: number;
}
export type TaskExecutor = (ctx: TaskExecutionContext) => Promise<TaskExecutionResult>;
export interface OrchestratorDeps {
    readonly runManager: RunManager;
    readonly persistence: PersistenceAdapter;
    readonly registry: AgentRegistry;
    readonly router: ModelRouter;
    readonly executor: TaskExecutor;
    readonly worktreeForTask?: (task: Task) => Promise<string | undefined>;
    readonly mergeWorktree?: (workspaceDir: string) => Promise<void>;
    readonly cleanupWorktree?: (workspaceDir: string) => Promise<void>;
    readonly now?: () => number;
}
export type RunOutcome = "succeeded" | "failed" | "cancelled" | "paused" | "budget-exhausted";
export interface RunProgress {
    readonly runId: string;
    readonly status: RunFullState;
    readonly tasks: {
        id: string;
        title: string;
        status: TaskState;
    }[];
    readonly percent: number;
    readonly activeWorkers: number;
}
export declare class Orchestrator {
    private readonly deps;
    private readonly now;
    private abortControllers;
    /** taskId → runId index so cancel(runId) aborts only that run's workers. */
    private taskRunIndex;
    private paused;
    private cancelled;
    constructor(deps: OrchestratorDeps);
    /** Drive a run to completion. Resolves with the final outcome. */
    run(runId: string): Promise<RunOutcome>;
    private startTask;
    /**
     * Drive the approval state machine for tasks parked in WAITING_APPROVAL.
     *
     *  - an `approved` approval → task returned in `resumable` (the main loop
     *    re-enters `startTask`, which transitions WAITING_APPROVAL → RUNNING and
     *    continues the SAME execution attempt — no attempts increment);
     *  - a `rejected` approval → task FAILED, dependents SKIPPED (a human said
     *    no — re-queueing would circumvent the decision, FR-102);
     *  - a `pending` approval past `expiresAt` → auto-decided `expired` (propagates
     *    like a rejection), so nothing waits forever.
     */
    private processApprovals;
    /**
     * Record a human decision (`approved`/`rejected`) on pending approvals of a
     * run. Returns how many approvals were updated. Expired approvals are untouchable.
     */
    decideApproval(runId: string, status: "approved" | "rejected", decidedBy: string, taskId?: string): Promise<number>;
    pause(runId: string): void;
    resume(runId: string): void;
    cancel(runId: string): void;
    /** Number of tasks currently executing (RUNNING/VERIFYING/WAITING_APPROVAL). */
    activeWorkers(runId: string): Promise<number>;
    private waitWhilePaused;
    private sleep;
    private outcomeFromStatus;
}
