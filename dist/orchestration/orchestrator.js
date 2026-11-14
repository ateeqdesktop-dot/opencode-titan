import { BudgetManager, BudgetExceededError } from "../platform/budget.js";
import { isRetryable } from "../domain/types.js";
import { verifyExecution, needsApproval } from "../verification/gates.js";
import { sanitizeForStore } from "../security/redact.js";
import { randomUUID } from "node:crypto";
export class Orchestrator {
    deps;
    now;
    abortControllers = new Map();
    /** taskId → runId index so cancel(runId) aborts only that run's workers. */
    taskRunIndex = new Map();
    paused = new Set();
    cancelled = new Set();
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? (() => Date.now());
    }
    /** Drive a run to completion. Resolves with the final outcome. */
    async run(runId) {
        const rm = this.deps.runManager;
        const run = await rm.getRun(runId);
        if (!run)
            throw new Error(`Run not found: ${runId}`);
        // Refuse to double-drive: a second /titan run for an already-running run
        // would spawn a second scheduling loop for the same persisted state.
        if (run.status === "RUNNING")
            throw new Error(`Run ${runId} is already RUNNING — use /titan status ${runId}`);
        // Move CREATED/PREFLIGHT → RUNNING as needed.
        if (run.status === "CREATED")
            await rm.transitionRun(runId, "PREFLIGHT", "orchestrator start");
        if ((await rm.getRun(runId)).status === "PREFLIGHT")
            await rm.transitionRun(runId, "ANALYZING", "analysis");
        const r2 = (await rm.getRun(runId));
        if (r2.status === "ANALYZING")
            await rm.transitionRun(runId, "PLANNING", "planning");
        const r3 = (await rm.getRun(runId));
        if (r3.status === "PLANNING")
            await rm.transitionRun(runId, "READY", "plan ready");
        const r4 = (await rm.getRun(runId));
        if (r4.status === "READY" || r4.status === "AWAITING_APPROVAL") {
            await rm.transitionRun(runId, "RUNNING", "execution started");
        }
        const budget = new BudgetManager(run.budget, this.now());
        const maxWorkers = budget.maxWorkers;
        // Main scheduling loop.
        while (true) {
            if (this.cancelled.has(runId)) {
                await rm.transitionRun(runId, "CANCELLED", "user cancelled").catch(() => { });
                return "cancelled";
            }
            if (this.paused.has(runId)) {
                await rm.transitionRun(runId, "PAUSED", "user paused").catch(() => { });
                // Wait until resumed or cancelled.
                await this.waitWhilePaused(runId);
                if (this.cancelled.has(runId)) {
                    await rm.transitionRun(runId, "CANCELLED", "cancelled while paused").catch(() => { });
                    return "cancelled";
                }
                await rm.transitionRun(runId, "RUNNING", "resumed").catch(() => { });
            }
            const currentRun = (await rm.getRun(runId));
            if (currentRun.status !== "RUNNING") {
                // Terminal or unknown — stop.
                return this.outcomeFromStatus(currentRun.status);
            }
            // Budget gate (FR-047).
            const stop = budget.shouldStopScheduling(this.now());
            if (stop.stop) {
                await rm.transitionRun(runId, "PAUSED", stop.reason).catch(() => { });
                return "budget-exhausted";
            }
            const tasks = await rm.getTasks(runId);
            // Drive the approval state machine FIRST: expired/rejected approvals fail
            // their parked tasks; approved ones are returned for resumption.
            const { resumable } = await this.processApprovals(runId, tasks);
            const running = tasks.filter((t) => t.status === "RUNNING" || t.status === "VERIFYING" || t.status === "WAITING_APPROVAL");
            const slots = maxWorkers - running.length;
            if (slots <= 0) {
                // Wait for a worker to finish.
                await this.sleep(50);
                continue;
            }
            const ready = await rm.readyTasks(runId);
            // Exclude tasks already running/queued-attempted.
            const candidates = ready.filter((t) => t.status === "READY" || t.status === "QUEUED" || t.status === "DRAFT");
            // Resumptions (approved approvals) take priority over new launches; both
            // consume slots so concurrency limits hold while work is waiting.
            const launches = [...resumable.slice(0, slots)];
            const freshSlots = slots - launches.length;
            if (freshSlots > 0)
                launches.push(...candidates.slice(0, freshSlots));
            if (launches.length === 0) {
                if (running.length > 0) {
                    await this.sleep(50);
                    continue;
                }
                break;
            }
            // Launch up to `slots` tasks concurrently.
            await Promise.all(launches.map((t) => this.startTask(runId, t.id, budget, maxWorkers)));
        }
        // All tasks done — determine run outcome.
        const finalTasks = await rm.getTasks(runId);
        const anyFailed = finalTasks.some((t) => t.status === "FAILED");
        const allSucceeded = finalTasks.every((t) => t.status === "SUCCEEDED" || t.status === "SKIPPED" || t.status === "CANCELLED");
        if (anyFailed && !allSucceeded) {
            await rm.transitionRun(runId, "FAILED", "one or more tasks failed").catch(() => { });
            return "failed";
        }
        await rm.transitionRun(runId, "VERIFYING", "all tasks done").catch(() => { });
        await rm.transitionRun(runId, "SUCCEEDED", "run complete").catch(() => { });
        await rm.transitionRun(runId, "CLOSED", "closed").catch(() => { });
        return "succeeded";
    }
    async startTask(runId, taskId, budget, maxWorkers) {
        const rm = this.deps.runManager;
        const task = await rm.getTask(taskId);
        if (!task)
            return;
        const run = await rm.getRun(runId);
        if (!run)
            return;
        // Budget: attempts.
        if (!budget.canAttempt(task.attempts)) {
            await rm.transitionTask(taskId, "FAILED", "max attempts exceeded").catch(() => { });
            return;
        }
        // Lease.
        const owner = `worker-${taskId}-${this.now()}`;
        const acquired = await rm.acquireTaskLease(taskId, owner, 5 * 60 * 1000);
        if (!acquired)
            return; // someone else owns it
        // Assign role + model.
        const roleId = rm.selectRoleForTask(task);
        await rm.assignRole(taskId, roleId).catch(() => { });
        const role = this.deps.registry.get(roleId);
        const model = this.deps.router.route({
            taskType: task.type,
            requiresTools: role.allowedTools.length > 0,
            preferred: role.preferredModel ? [`${role.preferredModel}`] : [],
            allowlist: [],
            allowFallback: role.fallbackModels.length > 0,
        });
        // Attach preferred model from role if present in available models.
        if (role.preferredModel) {
            const avail = this.deps.router.getAvailable();
            const hit = avail.find((m) => `${m.providerID}/${m.modelID}` === role.preferredModel);
            if (hit) {
                // Re-route with pin to honor role preference.
                try {
                    const pinned = this.deps.router.route({
                        taskType: task.type,
                        requiresTools: role.allowedTools.length > 0,
                        pinnedModel: role.preferredModel,
                        allowlist: [],
                        allowFallback: role.fallbackModels.length > 0,
                    });
                    Object.assign(model, pinned);
                }
                catch {
                    // keep cheapest
                }
            }
        }
        // Worktree.
        let workspaceDir;
        if (role.workspacePolicy === "isolated-write" && this.deps.worktreeForTask) {
            workspaceDir = await this.deps.worktreeForTask(task).catch(() => undefined);
        }
        // Transition to RUNNING — fresh start vs approval-resume path.
        const cur = await rm.getTask(taskId);
        const resuming = cur?.status === "WAITING_APPROVAL";
        if (resuming) {
            await rm.transitionTask(taskId, "RUNNING", "approval granted, resuming execution").catch(() => { });
        }
        else {
            if (cur && (cur.status === "DRAFT" || cur.status === "BLOCKED")) {
                await rm.transitionTask(taskId, "READY").catch(() => { });
            }
            await rm.transitionTask(taskId, "QUEUED").catch(() => { });
            await rm.transitionTask(taskId, "RUNNING").catch(() => { });
        }
        const t = await rm.getTask(taskId);
        if (t) {
            // Attempts count EXECUTIONS: fresh start increments once; an approval
            // resume continues the single execution that was gated, not a new attempt.
            if (!resuming)
                t.attempts = (t.attempts ?? 0) + 1;
            if (workspaceDir)
                t.workspaceId = workspaceDir;
            await rm.updateTask(t);
        }
        // Attempt budget check (after RUNNING so FAILED transition is legal).
        const freshT = await rm.getTask(taskId);
        if (freshT && !budget.canAttempt(freshT.attempts - 1)) {
            await rm.transitionTask(taskId, "FAILED", "max attempts exceeded").catch(() => { });
            await rm.releaseTaskLease(taskId, owner).catch(() => { });
            this.abortControllers.delete(taskId);
            this.taskRunIndex.delete(taskId);
            return;
        }
        // Supervised approval gate (SRS FR-102, RUN mode "supervised"): mutating
        // task types need a human decision before the worker model session runs.
        // The task parks in WAITING_APPROVAL; the scheduling loop keeps the slot so
        // concurrency limits still hold while waiting, and executes the moment the
        // approval is granted (or fails it on expiry/rejection).
        if (!resuming && run.mode === "supervised" && needsApproval(task) && (freshT?.attempts ?? 0) <= 1) {
            const approvals = await this.deps.persistence.listApprovalsByRun(runId);
            const mine = approvals.filter((a) => a.taskId === taskId);
            const hasApproved = mine.some((a) => a.status === "approved" && (!a.expiresAt || a.expiresAt > this.now()));
            const hasPending = mine.some((a) => a.status === "pending");
            if (hasApproved) {
                // resume execution below (task already RUNNING)
            }
            else if (hasPending) {
                await rm.transitionTask(taskId, "WAITING_APPROVAL", "awaiting human approval").catch(() => { });
                await rm.releaseTaskLease(taskId, owner).catch(() => { });
                this.abortControllers.delete(taskId);
                this.taskRunIndex.delete(taskId);
                return;
            }
            else {
                const apr = {
                    id: `APR-${randomUUID().slice(0, 8)}`,
                    runId,
                    taskId,
                    action: "task.execute",
                    resource: taskId,
                    requestedBy: "titan.orchestrator",
                    reason: `supervised run: ${task.type} task "${task.title}"`,
                    status: "pending",
                    expiresAt: this.now() + 8 * 60 * 60 * 1000,
                };
                await this.deps.persistence.putApproval(apr);
                await rm.transitionTask(taskId, "WAITING_APPROVAL", `approval requested: ${apr.id}`).catch(() => { });
                await this.deps.persistence.appendEvent({
                    type: "approval.requested",
                    runId,
                    taskId,
                    schemaVersion: 1,
                    payload: JSON.stringify({ approvalId: apr.id, action: apr.action }),
                    at: this.now(),
                });
                await rm.releaseTaskLease(taskId, owner).catch(() => { });
                this.abortControllers.delete(taskId);
                this.taskRunIndex.delete(taskId);
                return;
            }
        }
        // Pre-launch budget gate: a run that has exhausted its budget must not spend
        // further model calls. The task is left in its current (pre-execution) state;
        // the scheduler loop stops and reports budget-exhausted (FR-047).
        try {
            budget.assertCanSpend(0, this.now());
        }
        catch (e) {
            if (e instanceof BudgetExceededError) {
                await rm.releaseTaskLease(taskId, owner).catch(() => { });
                return;
            }
            throw e;
        }
        // Execute.
        const ac = new AbortController();
        this.abortControllers.set(taskId, ac);
        this.taskRunIndex.set(taskId, runId);
        let result;
        try {
            budget.assertCanSpend(0, this.now());
            result = await Promise.race([
                this.deps.executor({
                    run: run,
                    task: (await rm.getTask(taskId)),
                    role: roleId,
                    model,
                    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
                    signal: ac.signal,
                }),
                new Promise((resolve) => {
                    if (ac.signal.aborted) {
                        resolve({ ok: false, evidence: [], errorClass: "session", errorMessage: "aborted" });
                        return;
                    }
                    ac.signal.addEventListener("abort", () => resolve({ ok: false, evidence: [], errorClass: "session", errorMessage: "aborted" }), { once: true });
                }),
            ]);
        }
        catch (e) {
            result = {
                ok: false,
                evidence: [],
                errorClass: "task-execution",
                errorMessage: String(e),
            };
        }
        finally {
            this.abortControllers.delete(taskId);
            this.taskRunIndex.delete(taskId);
        }
        // Record budget usage.
        if (result.modelCalls)
            budget.recordModelCall(result.costUsd ?? 0);
        if (result.costUsd)
            budget.recordActualCost(result.costUsd);
        // Release lease.
        await rm.releaseTaskLease(taskId, owner).catch(() => { });
        // Persist result + transition. Evidence is sanitized before it reaches
        // durable state — anything resembling a credential is masked (SRS §11).
        const updated = await rm.getTask(taskId);
        if (updated) {
            updated.evidence = [
                ...updated.evidence,
                ...result.evidence.map((e) => ({ ...e, summary: sanitizeForStore(e.summary).text, at: this.now() })),
            ];
            await rm.updateTask(updated);
        }
        if (result.ok) {
            // Verification gate (SRS §9, FR-062..FR-064): acceptance criteria that
            // demand evidence get checked BEFORE the task may reach SUCCEEDED.
            const verdict = verifyExecution((await rm.getTask(taskId)), result);
            await this.deps.persistence.appendEvent({
                type: "verify.result",
                runId,
                taskId,
                schemaVersion: 1,
                payload: JSON.stringify({ ok: verdict.ok, issues: verdict.issues }),
                at: this.now(),
            });
            if (verdict.ok) {
                await rm.transitionTask(taskId, "VERIFYING").catch(() => { });
                await rm.transitionTask(taskId, "SUCCEEDED").catch(() => { });
                // FR-061: merge isolated worktree changes back into the main tree.
                if (workspaceDir && this.deps.mergeWorktree) {
                    await this.deps.mergeWorktree(workspaceDir).catch((e) => console.error(`[titan] mergeWorktree failed for ${taskId}:`, e));
                }
            }
            else {
                const reason = sanitizeForStore(`verification gate rejected: ${verdict.issues.join("; ")}`).text;
                await rm.transitionTask(taskId, "FAILED", reason).catch(() => { });
                // Gate failures are reworkable while attempts remain.
                const post = await rm.getTask(taskId);
                if (!this.cancelled.has(runId) && post && post.attempts < post.limits.maxAttempts) {
                    await rm.transitionTask(taskId, "NEEDS_REWORK", "verification failed, re-queue").catch(() => { });
                    await rm.transitionTask(taskId, "QUEUED").catch(() => { });
                }
            }
        }
        else {
            // Failure propagation policy: dependents of a failed task are SKIPPED so
            // the DAG can never start them on stale upstream results (FR-026/027).
            const dag = await rm.dagForRun(runId);
            dag.setState(taskId, "failed");
            const skipped = dag.propagateFailure(taskId);
            for (const sid of skipped) {
                await rm.transitionTask(sid, "SKIPPED", `upstream ${taskId} failed`).catch(() => { });
            }
            const cls = result.errorClass ?? "task-execution";
            await rm.transitionTask(taskId, "FAILED", result.errorMessage).catch(() => { });
            // If retryable and attempts remain, route back through rework → QUEUED.
            // Never after a user cancel: cancelled work must stay stopped (FR-106).
            const post = await rm.getTask(taskId);
            if (!this.cancelled.has(runId) && post && isRetryable(cls) && post.attempts < post.limits.maxAttempts) {
                await rm.transitionTask(taskId, "NEEDS_REWORK", "retryable failure, re-queue").catch(() => { });
                await rm.transitionTask(taskId, "QUEUED").catch(() => { });
            }
        }
        // Journal progress.
        await this.deps.persistence.appendEvent({
            type: "task.finished",
            runId,
            taskId,
            schemaVersion: 1,
            payload: JSON.stringify({ ok: result.ok, errorClass: result.errorClass }),
            at: this.now(),
        });
        // Worktree cleanup (FR-060): always remove the isolated worktree after the
        // task finishes, whether it succeeded, failed, or was cancelled.
        if (workspaceDir && this.deps.cleanupWorktree) {
            await this.deps.cleanupWorktree(workspaceDir).catch((e) => console.error(`[titan] cleanupWorktree failed for ${taskId}:`, e));
        }
    }
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
    async processApprovals(runId, tasks) {
        const waiting = tasks.filter((t) => t.status === "WAITING_APPROVAL");
        if (waiting.length === 0)
            return { resumable: [] };
        const rm = this.deps.runManager;
        const approvals = await this.deps.persistence.listApprovalsByRun(runId);
        const resumable = [];
        for (const t of waiting) {
            const mine = approvals.filter((a) => a.taskId === t.id);
            if (mine.some((a) => a.status === "approved")) {
                resumable.push(t);
                continue;
            }
            const rejected = mine.find((a) => a.status === "rejected");
            const expired = mine.find((a) => a.status === "pending" && a.expiresAt !== undefined && a.expiresAt < this.now());
            if (!rejected && !expired)
                continue;
            const decision = rejected ? "rejected" : "expired";
            const reason = `approval ${decision}${rejected?.decidedBy ? ` by ${rejected.decidedBy}` : ""}`;
            await rm.transitionTask(t.id, "FAILED", reason).catch(() => { });
            await this.deps.persistence.appendEvent({
                type: "approval.decided",
                runId,
                taskId: t.id,
                schemaVersion: 1,
                payload: JSON.stringify({ decision, source: "orchestrator" }),
                at: this.now(),
            });
            // Dependents of a task that will never run are SKIPPED (ADR-006).
            const dag = await rm.dagForRun(runId);
            dag.setState(t.id, "failed");
            const skipped = dag.propagateFailure(t.id);
            for (const sid of skipped) {
                await rm.transitionTask(sid, "SKIPPED", `upstream ${t.id} approval ${decision}`).catch(() => { });
            }
        }
        return { resumable };
    }
    /**
     * Record a human decision (`approved`/`rejected`) on pending approvals of a
     * run. Returns how many approvals were updated. Expired approvals are untouchable.
     */
    async decideApproval(runId, status, decidedBy, taskId) {
        const now = this.now();
        const pendings = await this.deps.persistence.listPendingApprovals();
        const mine = pendings.filter((a) => a.runId === runId && (!taskId || a.taskId === taskId) && (!a.expiresAt || a.expiresAt > now));
        for (const a of mine) {
            await this.deps.persistence.putApproval({ ...a, status, decidedBy, decidedAt: now });
        }
        if (mine.length > 0) {
            await this.deps.persistence.appendEvent({
                type: "approval.decided",
                runId,
                schemaVersion: 1,
                payload: JSON.stringify({
                    decision: status,
                    decidedBy,
                    approvals: mine.map((a) => a.id),
                }),
                at: now,
            });
        }
        return mine.length;
    }
    pause(runId) {
        this.paused.add(runId);
    }
    resume(runId) {
        this.paused.delete(runId);
    }
    cancel(runId) {
        this.cancelled.add(runId);
        // Abort only the in-flight workers belonging to this run (taskRunIndex).
        for (const [tid, rid] of this.taskRunIndex) {
            if (rid !== runId)
                continue;
            const ac = this.abortControllers.get(tid);
            if (ac)
                ac.abort();
        }
    }
    /** Number of tasks currently executing (RUNNING/VERIFYING/WAITING_APPROVAL). */
    async activeWorkers(runId) {
        const tasks = await this.deps.runManager.getTasks(runId);
        return tasks.filter((t) => t.status === "RUNNING" || t.status === "VERIFYING" || t.status === "WAITING_APPROVAL").length;
    }
    async waitWhilePaused(runId) {
        while (this.paused.has(runId) && !this.cancelled.has(runId)) {
            await this.sleep(100);
        }
    }
    sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }
    outcomeFromStatus(s) {
        if (s === "SUCCEEDED" || s === "CLOSED")
            return "succeeded";
        if (s === "CANCELLED")
            return "cancelled";
        if (s === "PAUSED")
            return "paused";
        return "failed";
    }
}
