/**
 * Typed RPC contract between TITAN server part and TUI part (SRS FR-005).
 *
 * Versioned: every payload carries `schemaVersion`. The TUI part validates
 * incoming payloads against the matching version and rejects (with a typed
 * error) anything it cannot decode — forward/backward compatibility is tested
 * in `test/unit/rpc.test.ts`.
 *
 * Only JSON-serializable, dependency-free types live here so both sides
 * (server running on Bun, TUI running in the Solid renderer) can import them
 * without pulling in runtime-specific modules.
 */
export declare const RPC_SCHEMA_VERSION: 1;
export interface RunSummary {
    readonly schemaVersion: typeof RPC_SCHEMA_VERSION;
    readonly id: string;
    readonly goal: string;
    readonly status: string;
    readonly mode: string;
    readonly tasksTotal: number;
    readonly tasksSucceeded: number;
    readonly tasksFailed: number;
    readonly tasksSkipped: number;
    readonly activeWorkers: number;
    readonly closedAt?: number;
}
export interface TaskSummary {
    readonly schemaVersion: typeof RPC_SCHEMA_VERSION;
    readonly id: string;
    readonly runId: string;
    readonly title: string;
    readonly type: string;
    readonly status: string;
    readonly assignedRole?: string;
    readonly evidenceCount: number;
}
export interface ApprovalSummary {
    readonly schemaVersion: typeof RPC_SCHEMA_VERSION;
    readonly id: string;
    readonly runId: string;
    readonly taskId?: string;
    readonly status: string;
    readonly reason: string;
    readonly expiresAt?: number;
}
export type RpcRequest = {
    readonly kind: "run.status";
    readonly runId: string;
} | {
    readonly kind: "run.list";
} | {
    readonly kind: "task.list";
    readonly runId: string;
} | {
    readonly kind: "approval.list";
    readonly runId: string;
} | {
    readonly kind: "approval.decide";
    readonly runId: string;
    readonly status: "approved" | "rejected";
    readonly decidedBy: string;
};
export type RpcResponse = {
    readonly ok: true;
    readonly data: RunSummary | RunSummary[] | TaskSummary[] | ApprovalSummary[] | {
        decided: number;
    };
} | {
    readonly ok: false;
    readonly error: string;
    readonly code: "not-found" | "invalid" | "version-mismatch" | "internal";
};
/** Type guard: is this an RPC request we understand at this schema version? */
export declare function isRpcRequest(value: unknown): value is RpcRequest;
/** Validate an RPC request and return a typed error if invalid. */
export declare function validateRequest(value: unknown): {
    ok: true;
    req: RpcRequest;
} | {
    ok: false;
    error: string;
};
/** Build a RunSummary from raw run/task data (server side). */
export declare function makeRunSummary(input: {
    id: string;
    goal: string;
    status: string;
    mode: string;
    tasks: readonly {
        status: string;
    }[];
    activeWorkers: number;
    closedAt?: number;
}): RunSummary;
