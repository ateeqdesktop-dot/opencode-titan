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
export const RPC_SCHEMA_VERSION = 1 as const

export interface RunSummary {
  readonly schemaVersion: typeof RPC_SCHEMA_VERSION
  readonly id: string
  readonly goal: string
  readonly status: string
  readonly mode: string
  readonly tasksTotal: number
  readonly tasksSucceeded: number
  readonly tasksFailed: number
  readonly tasksSkipped: number
  readonly activeWorkers: number
  readonly closedAt?: number
}

export interface TaskSummary {
  readonly schemaVersion: typeof RPC_SCHEMA_VERSION
  readonly id: string
  readonly runId: string
  readonly title: string
  readonly type: string
  readonly status: string
  readonly assignedRole?: string
  readonly evidenceCount: number
}

export interface ApprovalSummary {
  readonly schemaVersion: typeof RPC_SCHEMA_VERSION
  readonly id: string
  readonly runId: string
  readonly taskId?: string
  readonly status: string
  readonly reason: string
  readonly expiresAt?: number
}

export type RpcRequest =
  | { readonly kind: "run.status"; readonly runId: string }
  | { readonly kind: "run.list" }
  | { readonly kind: "task.list"; readonly runId: string }
  | { readonly kind: "approval.list"; readonly runId: string }
  | { readonly kind: "approval.decide"; readonly runId: string; readonly status: "approved" | "rejected"; readonly decidedBy: string }

export type RpcResponse =
  | { readonly ok: true; readonly data: RunSummary | RunSummary[] | TaskSummary[] | ApprovalSummary[] | { decided: number } }
  | { readonly ok: false; readonly error: string; readonly code: "not-found" | "invalid" | "version-mismatch" | "internal" }

/** Type guard: is this an RPC request we understand at this schema version? */
export function isRpcRequest(value: unknown): value is RpcRequest {
  if (typeof value !== "object" || value === null) return false
  const v = value as { kind?: unknown }
  return (
    v.kind === "run.status" ||
    v.kind === "run.list" ||
    v.kind === "task.list" ||
    v.kind === "approval.list" ||
    v.kind === "approval.decide"
  )
}

/** Validate an RPC request and return a typed error if invalid. */
export function validateRequest(value: unknown): { ok: true; req: RpcRequest } | { ok: false; error: string } {
  if (!isRpcRequest(value)) return { ok: false, error: "unknown or malformed request kind" }
  const v = value as Record<string, unknown>
  switch (v.kind) {
    case "run.status":
    case "task.list":
    case "approval.list":
      if (typeof v.runId !== "string" || v.runId.length === 0) return { ok: false, error: "runId must be a non-empty string" }
      break
    case "approval.decide":
      if (typeof v.runId !== "string" || v.runId.length === 0) return { ok: false, error: "runId must be a non-empty string" }
      if (v.status !== "approved" && v.status !== "rejected") return { ok: false, error: "status must be approved|rejected" }
      if (typeof v.decidedBy !== "string" || v.decidedBy.length === 0) return { ok: false, error: "decidedBy must be a non-empty string" }
      break
    case "run.list":
      break
  }
  return { ok: true, req: value as RpcRequest }
}

/** Build a RunSummary from raw run/task data (server side). */
export function makeRunSummary(input: {
  id: string
  goal: string
  status: string
  mode: string
  tasks: readonly { status: string }[]
  activeWorkers: number
  closedAt?: number
}): RunSummary {
  const tasks = input.tasks
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
  }
}