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
export const RPC_SCHEMA_VERSION = 1;
/** Type guard: is this an RPC request we understand at this schema version? */
export function isRpcRequest(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const v = value;
    return (v.kind === "run.status" ||
        v.kind === "run.list" ||
        v.kind === "task.list" ||
        v.kind === "approval.list" ||
        v.kind === "approval.decide");
}
/** Validate an RPC request and return a typed error if invalid. */
export function validateRequest(value) {
    if (!isRpcRequest(value))
        return { ok: false, error: "unknown or malformed request kind" };
    const v = value;
    switch (v.kind) {
        case "run.status":
        case "task.list":
        case "approval.list":
            if (typeof v.runId !== "string" || v.runId.length === 0)
                return { ok: false, error: "runId must be a non-empty string" };
            break;
        case "approval.decide":
            if (typeof v.runId !== "string" || v.runId.length === 0)
                return { ok: false, error: "runId must be a non-empty string" };
            if (v.status !== "approved" && v.status !== "rejected")
                return { ok: false, error: "status must be approved|rejected" };
            if (typeof v.decidedBy !== "string" || v.decidedBy.length === 0)
                return { ok: false, error: "decidedBy must be a non-empty string" };
            break;
        case "run.list":
            break;
    }
    return { ok: true, req: value };
}
/** Build a RunSummary from raw run/task data (server side). */
export function makeRunSummary(input) {
    const tasks = input.tasks;
    return {
        schemaVersion: RPC_SCHEMA_VERSION,
        id: input.id,
        goal: input.goal,
        status: input.status,
        mode: input.mode,
        tasksTotal: tasks.length,
        tasksSucceeded: tasks.filter((t) => t.status === "SUCCEEDED").length,
        tasksFailed: tasks.filter((t) => t.status === "FAILED").length,
        tasksSkipped: tasks.filter((t) => t.status === "SKIPPED").length,
        activeWorkers: input.activeWorkers,
        ...(input.closedAt !== undefined ? { closedAt: input.closedAt } : {}),
    };
}
