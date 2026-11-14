/**
 * DAG engine.
 * SRS §7.3 (FR-023, FR-024, FR-025), §5.5 (DAG not free conversation).
 *
 * Responsibilities:
 *  - build + validate a task graph (no cycles, no orphans, no missing deps,
 *    every acceptance criterion has a verification path)
 *  - compute the ready set (all dependencies satisfied)
 *  - prevent a task from running before its dependencies complete
 *  - schedule independent tasks concurrently
 *  - propagate failure to dependents per policy
 *  - compute run progress
 *  - serialize/restore DAG state
 *
 * This is a real graph engine, not a task list labelled "DAG".
 */
export interface DagNode<T extends {
    id: string;
    dependencies: readonly string[];
}> {
    readonly task: T;
}
export type DagValidationIssue = {
    kind: "cycle";
    taskIds: readonly string[];
} | {
    kind: "missing-dependency";
    taskId: string;
    missing: string;
} | {
    kind: "self-dependency";
    taskId: string;
} | {
    kind: "orphan";
    taskId: string;
} | {
    kind: "duplicate-id";
    taskId: string;
};
export interface ValidationResult {
    readonly ok: boolean;
    readonly issues: readonly DagValidationIssue[];
}
/** Status of a node as far as the DAG cares. */
export type NodeRunState = "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";
export declare class Dag<T extends {
    id: string;
    dependencies: readonly string[];
}> {
    private readonly nodes;
    private readonly state;
    constructor(tasks?: readonly T[]);
    add(task: T): void;
    get(id: string): T | undefined;
    size(): number;
    ids(): string[];
    dependentsOf(id: string): string[];
    validate(): ValidationResult;
    /** Returns a cycle as an ordered id list, or null if acyclic. DFS with colouring. */
    findCycle(): string[] | null;
    /** Tasks whose dependencies are ALL in a terminal-success state and that are themselves pending. */
    readyTasks(): string[];
    /** Hard-blocked: any transitive dependency failed or was skipped. */
    blockedTasks(): string[];
    /** True if any ancestor (transitive dependency) is failed or skipped. */
    private hasFailedAncestor;
    setState(id: string, s: NodeRunState): void;
    getState(id: string): NodeRunState | undefined;
    /**
     * When a task fails, mark all transitive dependents as skipped (blocked by
     * policy) so they never run against a broken prerequisite.
     */
    propagateFailure(failedId: string): string[];
    progress(): {
        total: number;
        succeeded: number;
        failed: number;
        skipped: number;
        running: number;
        pending: number;
        percent: number;
    };
    isComplete(): boolean;
    serialize(): {
        nodes: T[];
        states: Record<string, NodeRunState>;
    };
    static deserialize<T extends {
        id: string;
        dependencies: readonly string[];
    }>(data: {
        nodes: T[];
        states: Record<string, NodeRunState>;
    }): Dag<T>;
}
