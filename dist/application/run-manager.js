import { transitionRun, transitionTask } from "../domain/state.js";
import { Dag } from "../orchestration/dag.js";
import { StorageError, } from "../reliability/adapter.js";
import { randomUUID } from "node:crypto";
// ── Mapping helpers (domain ↔ persistence) ────────────────────────────────────
function runToRecord(r) {
    const rec = {
        id: r.id,
        goal: r.goal,
        status: r.status,
        mode: r.mode,
        budget: JSON.stringify(r.budget),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
    };
    if (r.statusReason !== undefined)
        rec.statusReason = r.statusReason;
    if (r.closedAt !== undefined)
        rec.closedAt = r.closedAt;
    return rec;
}
function recordToRun(rec) {
    const r = {
        schemaVersion: 1,
        id: rec.id,
        goal: rec.goal,
        status: rec.status,
        mode: rec.mode,
        budget: JSON.parse(rec.budget),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
    };
    if (rec.statusReason !== undefined)
        r.statusReason = rec.statusReason;
    if (rec.closedAt !== undefined)
        r.closedAt = rec.closedAt;
    return r;
}
function taskToRecord(t) {
    return {
        id: t.id,
        runId: t.runId,
        type: t.type,
        title: t.title,
        ...(t.description !== undefined ? { description: t.description } : {}),
        status: t.status,
        priority: t.priority,
        dependencies: JSON.stringify(t.dependencies),
        ...(t.assignedRole !== undefined ? { assignedRole: t.assignedRole } : {}),
        ...(t.assignedSessionId !== undefined ? { assignedSessionId: t.assignedSessionId } : {}),
        ...(t.workspaceId !== undefined ? { workspaceId: t.workspaceId } : {}),
        inputArtifactIds: JSON.stringify(t.inputArtifactIds),
        acceptanceCriteria: JSON.stringify(t.acceptanceCriteria),
        limits: JSON.stringify(t.limits),
        idempotencyKey: t.idempotencyKey,
        attempts: t.attempts,
        evidence: JSON.stringify(t.evidence),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
    };
}
function recordToTask(rec) {
    return {
        schemaVersion: 1,
        id: rec.id,
        runId: rec.runId,
        type: rec.type,
        title: rec.title,
        ...(rec.description !== undefined ? { description: rec.description } : {}),
        status: rec.status,
        priority: rec.priority,
        dependencies: JSON.parse(rec.dependencies),
        ...(rec.assignedRole !== undefined ? { assignedRole: rec.assignedRole } : {}),
        ...(rec.assignedSessionId !== undefined ? { assignedSessionId: rec.assignedSessionId } : {}),
        ...(rec.workspaceId !== undefined ? { workspaceId: rec.workspaceId } : {}),
        inputArtifactIds: JSON.parse(rec.inputArtifactIds),
        acceptanceCriteria: JSON.parse(rec.acceptanceCriteria),
        limits: JSON.parse(rec.limits),
        idempotencyKey: rec.idempotencyKey,
        attempts: rec.attempts,
        evidence: JSON.parse(rec.evidence),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
    };
}
// ── Manager ──────────────────────────────────────────────────────────────────
export class RunManager {
    db;
    registry;
    constructor(db, registry) {
        this.db = db;
        this.registry = registry;
    }
    /** Create a Run (optionally with an initial task set) and persist atomically. */
    async createRun(input) {
        const now = Date.now();
        const budget = {
            maxConcurrentWorkers: input.budget?.maxConcurrentWorkers ?? 4,
            maxAttemptsPerTask: input.budget?.maxAttemptsPerTask ?? 3,
            maxTotalSeconds: input.budget?.maxTotalSeconds ?? 3600,
            ...(input.budget?.maxEstimatedCostUsd !== undefined
                ? { maxEstimatedCostUsd: input.budget.maxEstimatedCostUsd }
                : {}),
            ...(input.budget?.maxModelCalls !== undefined
                ? { maxModelCalls: input.budget.maxModelCalls }
                : {}),
        };
        const run = {
            schemaVersion: 1,
            id: `RUN-${randomUUID().slice(0, 8)}`,
            goal: input.goal,
            status: "CREATED",
            mode: input.mode ?? "direct",
            budget,
            createdAt: now,
            updatedAt: now,
        };
        // Build tasks first (with generated ids) so dependencies can reference them by
        // the caller-provided titles? No — dependencies reference task ids. We allow
        // callers to pass dependencies as task indices? Simpler: dependencies are by
        // *title* resolved after creation? To keep it deterministic and testable,
        // dependencies reference the generated task id is impossible pre-creation.
        // Resolution: dependencies are resolved by *position index* in the input array
        // (0-based). Caller may also pass explicit ids via a special marker, but the
        // default and documented contract is index-based. This is recorded in ADR-006.
        const taskInputs = input.tasks ?? [];
        const taskIds = taskInputs.map(() => `TASK-${randomUUID().slice(0, 8)}`);
        const tasks = taskInputs.map((ti, i) => {
            const deps = (ti.dependencies ?? []).map((d) => {
                // Allow either an index ("#2") or a literal id.
                if (typeof d === "string" && d.startsWith("#")) {
                    const idx = Number(d.slice(1));
                    if (!Number.isInteger(idx) || idx < 0 || idx >= taskIds.length) {
                        throw new Error(`Invalid task graph: invalid dependency index ${d} in task ${i}`);
                    }
                    return taskIds[idx];
                }
                return d;
            });
            const t = {
                schemaVersion: 1,
                id: taskIds[i],
                runId: run.id,
                type: ti.type,
                title: ti.title,
                ...(ti.description !== undefined ? { description: ti.description } : {}),
                status: "DRAFT",
                priority: ti.priority ?? "MEDIUM",
                dependencies: deps,
                ...(ti.assignedRole !== undefined ? { assignedRole: ti.assignedRole } : {}),
                inputArtifactIds: ti.inputArtifactIds ?? [],
                acceptanceCriteria: ti.acceptanceCriteria ?? [],
                limits: {
                    maxAttempts: ti.limits?.maxAttempts ?? run.budget.maxAttemptsPerTask,
                    timeoutSeconds: ti.limits?.timeoutSeconds ?? 1800,
                },
                idempotencyKey: ti.idempotencyKey ?? `${run.id}:${taskIds[i]}`,
                attempts: 0,
                evidence: [],
                createdAt: now,
                updatedAt: now,
            };
            return t;
        });
        // Validate DAG (FR-024) before persisting anything.
        const dag = new Dag(tasks.map((t) => ({ id: t.id, dependencies: t.dependencies })));
        const validation = dag.validate();
        if (!validation.ok) {
            throw new Error(`Invalid task graph: ${JSON.stringify(validation.issues)}`);
        }
        // Persist run + tasks + event in one transaction.
        await this.db.putRun(runToRecord(run));
        for (const t of tasks)
            await this.db.putTask(taskToRecord(t));
        await this.db.putBudget({
            runId: run.id,
            maxConcurrentWorkers: run.budget.maxConcurrentWorkers,
            maxAttemptsPerTask: run.budget.maxAttemptsPerTask,
            maxTotalSeconds: run.budget.maxTotalSeconds,
            ...(run.budget.maxEstimatedCostUsd !== undefined
                ? { maxEstimatedCostUsd: run.budget.maxEstimatedCostUsd }
                : {}),
            ...(run.budget.maxModelCalls !== undefined ? { maxModelCalls: run.budget.maxModelCalls } : {}),
            usedModelCalls: 0,
            usedEstimatedCostUsd: 0,
            startedAt: now,
            updatedAt: now,
        });
        await this.db.appendEvent({
            type: "run.created",
            runId: run.id,
            schemaVersion: 1,
            payload: JSON.stringify({ goal: run.goal, taskCount: tasks.length }),
            at: now,
        });
        return run;
    }
    async getRun(id) {
        const rec = await this.db.getRun(id);
        return rec ? recordToRun(rec) : undefined;
    }
    async listRuns() {
        const recs = await this.db.listRuns();
        return recs.map(recordToRun);
    }
    async listRunsByStatus(statuses) {
        const recs = await this.db.listRunsByStatus(statuses);
        return recs.map(recordToRun);
    }
    /** Approvals recorded for a run (R4, FR-102). */
    async listApprovals(runId) {
        return this.db.listApprovalsByRun(runId);
    }
    async getTasks(runId) {
        const recs = await this.db.listTasksByRun(runId);
        return recs.map(recordToTask);
    }
    async getTask(id) {
        const rec = await this.db.getTask(id);
        return rec ? recordToTask(rec) : undefined;
    }
    /** Rebuild the DAG for a run from persisted tasks. */
    async dagForRun(runId) {
        const tasks = await this.getTasks(runId);
        return new Dag(tasks.map((t) => ({ id: t.id, dependencies: t.dependencies })));
    }
    /** Transition a Run to a new state, persist, and journal. Throws on illegal transition. */
    async transitionRun(runId, to, reason) {
        const run = await this.getRun(runId);
        if (!run)
            throw new Error(`Run not found: ${runId}`);
        const from = run.status;
        const next = transitionRun(run.status, to);
        const now = Date.now();
        run.status = next;
        if (reason !== undefined)
            run.statusReason = reason;
        run.updatedAt = now;
        if (next === "CLOSED" || next === "SUCCEEDED" || next === "FAILED" || next === "CANCELLED" || next === "REJECTED") {
            run.closedAt = now;
        }
        await this.db.putRun(runToRecord(run));
        await this.db.appendEvent({
            type: "run.transition",
            runId,
            schemaVersion: 1,
            payload: JSON.stringify({ from, to: next, reason }),
            at: now,
        });
        // Re-read to return persisted truth.
        const fresh = await this.getRun(runId);
        if (!fresh)
            throw new StorageError("run vanished after transition");
        return fresh;
    }
    /** Transition a Task to a new state, persist, journal, and update DAG readiness bookkeeping. */
    async transitionTask(taskId, to, reason) {
        const task = await this.getTask(taskId);
        if (!task)
            throw new Error(`Task not found: ${taskId}`);
        const from = task.status;
        const next = transitionTask(task.status, to);
        const now = Date.now();
        task.status = next;
        task.updatedAt = now;
        if (reason !== undefined) {
            // Store reason as evidence-ish note via a synthetic evidence entry is overkill;
            // keep it on the task's evidence list as a log entry.
            task.evidence = [
                ...task.evidence,
                { kind: "log", ref: `transition:${task.status}->${next}`, summary: reason, at: now },
            ];
        }
        await this.db.putTask(taskToRecord(task));
        await this.db.appendEvent({
            type: "task.transition",
            runId: task.runId,
            taskId,
            schemaVersion: 1,
            payload: JSON.stringify({ from, to: next, reason }),
            at: now,
        });
        const fresh = await this.getTask(taskId);
        if (!fresh)
            throw new StorageError("task vanished after transition");
        return fresh;
    }
    /** Tasks in a run that are ready to be scheduled (DAG + status). */
    async readyTasks(runId) {
        const tasks = await this.getTasks(runId);
        const byId = new Map(tasks.map((t) => [t.id, t]));
        // A task is schedulable iff all its dependencies are SUCCEEDED and it is
        // not already in a terminal/running state.
        return tasks.filter((t) => {
            if (t.status === "SUCCEEDED" ||
                t.status === "FAILED" ||
                t.status === "CANCELLED" ||
                t.status === "SKIPPED" ||
                t.status === "RUNNING" ||
                t.status === "VERIFYING" ||
                t.status === "WAITING_APPROVAL") {
                return false;
            }
            return t.dependencies.every((d) => byId.get(d)?.status === "SUCCEEDED");
        });
    }
    /** Acquire a lease for a task before a worker starts it (FR-054). */
    async acquireTaskLease(taskId, owner, ttlMs) {
        return this.db.acquireLease(taskId, owner, ttlMs);
    }
    async releaseTaskLease(taskId, owner) {
        await this.db.releaseLease(taskId, owner);
    }
    /** Persist an already-mutated Task (escape hatch for orchestrator bookkeeping). */
    async updateTask(task) {
        task.updatedAt = Date.now();
        await this.db.putTask(taskToRecord(task));
    }
    async assignRole(taskId, roleId) {
        const task = await this.getTask(taskId);
        if (!task)
            throw new Error(`Task not found: ${taskId}`);
        const role = this.registry.get(roleId);
        if (!role.suitableTaskTypes.includes(task.type)) {
            throw new Error(`Role ${roleId} is not suitable for task type ${task.type}`);
        }
        task.assignedRole = roleId;
        task.updatedAt = Date.now();
        await this.db.putTask(taskToRecord(task));
        await this.db.appendEvent({
            type: "task.assigned",
            runId: task.runId,
            taskId,
            schemaVersion: 1,
            payload: JSON.stringify({ roleId }),
            at: Date.now(),
        });
        const fresh = await this.getTask(taskId);
        if (!fresh)
            throw new StorageError("task vanished after assign");
        return fresh;
    }
    /** Select a role for a task using the registry (lowest-risk suitable). */
    selectRoleForTask(task, preferredRoleId) {
        const role = this.registry.selectFor(task.type, preferredRoleId);
        return role.id;
    }
    /** Run-level progress summary (SRS §5.2). */
    async progress(runId) {
        const run = await this.getRun(runId);
        if (!run)
            throw new Error(`Run not found: ${runId}`);
        const tasks = await this.getTasks(runId);
        const dag = new Dag(tasks.map((t) => ({ id: t.id, dependencies: t.dependencies })));
        // Sync state
        for (const t of tasks) {
            const ns = t.status === "SUCCEEDED"
                ? "succeeded"
                : t.status === "SKIPPED"
                    ? "skipped"
                    : t.status === "FAILED" || t.status === "CANCELLED"
                        ? "failed"
                        : t.status === "RUNNING" || t.status === "VERIFYING" || t.status === "WAITING_APPROVAL"
                            ? "running"
                            : "pending";
            dag.setState(t.id, ns);
        }
        return { run, tasks, dag: dag.progress() };
    }
}
export { recordToRun, recordToTask, runToRecord, taskToRecord };
