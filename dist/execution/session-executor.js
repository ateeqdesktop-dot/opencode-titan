// ── Pure, unit-testable policy helpers ───────────────────────────────────────
/** Interactive tools a session could use to mutate state or reach outside. */
const INTERACTIVE_TOOLS = ["write", "edit", "bash", "webfetch"];
/**
 * Which interactive tools must be denied for this role's session, per the
 * least-privilege rule (FR-100/101): every interactive tool outside
 * `role.allowedTools` is denied with a session-scoped permission.
 */
export function deniedToolsForRole(role) {
    return INTERACTIVE_TOOLS.filter((t) => !role.allowedTools.includes(t));
}
/**
 * Build the ADR-003 role-injection system part: who the worker is, what it may
 * touch, and how it must behave. Deterministic text derived from registry data.
 */
export function roleSystemText(role, goal) {
    const lines = [
        `You are the "${role.name}" role in a TITAN multi-agent run.`,
        `Overall run goal: ${goal}`,
        `Role objective: ${role.objective}`,
        role.skills.length > 0 ? `Role skills: ${role.skills.join(", ")}` : null,
        `Tools you may use: ${role.allowedTools.join(", ")}.`,
        role.workspacePolicy === "isolated-write"
            ? "You work in an isolated worktree. Write only inside your workspace."
            : "This is a shared read-only context: do NOT modify files; analysis and reporting only.",
        "Do not start new high-level initiatives beyond the given task.",
        "End your turn with a final line `TITAN_RESULT: <one-line outcome summary>`.",
    ];
    return lines.filter((l) => l !== null).join("\n");
}
/** The user prompt that carries the task into the worker session. */
export function taskPromptText(task, goal) {
    const ac = task.acceptanceCriteria.length
        ? `\nAcceptance criteria:\n${task.acceptanceCriteria
            .map((a) => `- [${a.id}] ${a.statement}${a.evidenceRequired ? " (evidence required)" : ""}`)
            .join("\n")}`
        : "";
    const deps = task.inputArtifactIds.length ? `\nRelevant artifacts: ${task.inputArtifactIds.join(", ")}` : "";
    return [
        `TITAN task ${task.id} (${task.type}, priority ${task.priority}).`,
        `Run goal: ${goal}`,
        `Task title: ${task.title}`,
        task.description ?? null,
        deps,
        ac,
    ]
        .filter((l) => l !== null)
        .join("\n");
}
/** Classify an unexpected error for the retry engine (SRS §12.1). */
export function classifySessionError(e) {
    const msg = String(e).toLowerCase();
    if (msg.includes("rate") || msg.includes("429") || msg.includes("too many requests") || msg.includes("insufficient") || msg.includes("funds") || msg.includes("quota"))
        return "rate-limit";
    if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted"))
        return "session";
    if (msg.includes("network") || msg.includes("econn") || msg.includes("fetch failed"))
        return "network";
    if (msg.includes("permission") || msg.includes("403"))
        return "permission";
    if (msg.includes("model") || msg.includes("provider"))
        return "provider";
    return "task-execution";
}
/** Pull the LAST assistant message out of a `session.context` payload. */
export function extractAssistant(payload) {
    const arr = Array.isArray(payload)
        ? payload
        : (payload?.data ?? payload?.messages ?? []);
    let last;
    for (const m of arr) {
        const o = m && typeof m === "object" ? m : null;
        if (o && o.type === "assistant")
            last = o;
    }
    if (!last)
        return { found: false, text: "" };
    const text = typeof last.text === "string" && last.text.length > 0
        ? last.text
        : Array.isArray(last.content)
            ? last.content
                .filter((c) => c?.type === "text")
                .map((c) => c?.text ?? "")
                .filter((t) => t.length > 0)
                .join("\n")
            : "";
    const tokens = last.tokens;
    const cost = typeof last.cost === "number" ? last.cost : undefined;
    const err = last.error;
    let errorMessage;
    if (typeof err === "string" && err.length > 0)
        errorMessage = err;
    else if (err && typeof err === "object" && typeof err.message === "string")
        errorMessage = err.message;
    return {
        found: true,
        text,
        ...(typeof last.finish === "string" ? { finish: last.finish } : {}),
        ...(tokens && typeof tokens.output === "number" ? { outputTokens: tokens.output } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
    };
}
/** One-line outcome: prefer the explicit `TITAN_RESULT:` line, else the last text line. */
export function summarizeOutcome(text) {
    const lines = text.split(/\r?\n/);
    const hit = lines.find((l) => /TITAN_RESULT:/.test(l));
    const base = hit ?? [...lines].reverse().find((l) => l.trim().length > 0) ?? "worker returned no text";
    return base.trim().slice(0, 240);
}
export function createSessionExecutor(o) {
    return async (exe) => {
        const { run, task, model, workspaceDir, signal } = exe;
        const role = o.registry.get(exe.role);
        const ctx = o.ctx;
        const timeoutMs = task.limits.timeoutSeconds * 1000 || o.defaultTimeoutMs || 30 * 60 * 1000;
        const permissions = deniedToolsForRole(role).map((tool) => ({
            action: tool,
            resource: "*",
            effect: "deny",
        }));
        let modelCalls = 0;
        let usedFallback = false;
        let sessionID;
        const createOne = (m) => ctx.session.create({
            title: `TITAN ${task.id} — ${task.title}`.slice(0, 120),
            model: { id: m.modelID, providerID: m.providerID },
            ...(workspaceDir ? { location: { directory: workspaceDir } } : {}),
            ...(permissions.length > 0 ? { permissions } : {}),
            metadata: { titan: { run: task.runId, task: task.id, role: role.id, goal: run.goal } },
        });
        try {
            // 1. Create the session (once; on retryable provider failure → fallback, FR-044).
            try {
                const created = await createOne({ modelID: model.modelID, providerID: model.providerID });
                sessionID = created.id;
                modelCalls++;
            }
            catch (e) {
                const fb = model.fallback;
                const cls = classifySessionError(e);
                if (!fb || (cls !== "rate-limit" && cls !== "network" && cls !== "provider"))
                    throw e;
                console.error(`[titan] session create failed (${cls}); falling back to ${fb.providerID}/${fb.modelID}`);
                const created = await createOne({ modelID: fb.modelID, providerID: fb.providerID });
                sessionID = created.id;
                modelCalls += 2;
                usedFallback = true;
            }
            if (!sessionID)
                throw new Error("session create returned no id");
            const sid = sessionID;
            // 2. ADR-003 role injection — one system part per model request for this session.
            const hookReg = await ctx.session.hook("context", (input) => {
                if (input.sessionID !== sid)
                    return;
                input.system.push({ type: "text", text: roleSystemText(role, run.goal) });
            });
            try {
                // 3. Real task work: one prompt → one complete model turn.
                await ctx.session.prompt({ sessionID: sid, text: taskPromptText(task, run.goal) });
                // 4. Wait for idle; race against task timeout and orchestration abort.
                const wait = ctx.session.wait({ sessionID: sid }).then(() => "done");
                const timeout = new Promise((resolve) => {
                    const t = setTimeout(() => resolve("timeout"), timeoutMs);
                    if (typeof t === "object" && t !== null)
                        t.unref?.();
                });
                const aborted = new Promise((resolve) => {
                    if (signal.aborted)
                        resolve("aborted");
                    else
                        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
                });
                const end = await Promise.race([wait, timeout, aborted]);
                if (end === "timeout" || end === "aborted") {
                    await ctx.session.interrupt({ sessionID: sid }).catch(() => { });
                    if (end === "timeout") {
                        const ex = extractSummaryAfterStop(ctx, sid);
                        const evidence = await ex;
                        return { ok: false, evidence, errorClass: "session", errorMessage: `task exceeded ${timeoutMs}ms`, modelCalls };
                    }
                    const evidence = await extractSummaryAfterStop(ctx, sid);
                    return { ok: false, evidence, errorClass: "session", errorMessage: "cancelled", modelCalls };
                }
                // 5. Judge the finished turn from the transcript.
                const context = await ctx.session.context({ sessionID: sid });
                const ex = extractAssistant(context);
                if (!ex.found) {
                    return { ok: false, evidence: [], errorClass: "session", errorMessage: "no assistant message found after wait", modelCalls };
                }
                const summary = summarizeOutcome(ex.text);
                const evidence = [
                    { kind: "log", ref: sid, summary, ok: ex.finish === "stop" },
                ];
                if (ex.finish === "stop") {
                    return {
                        ok: true,
                        evidence,
                        ...(ex.costUsd !== undefined ? { costUsd: ex.costUsd } : {}),
                        modelCalls,
                    };
                }
                const cls = ex.finish === "error" ? "provider" : ex.finish === "content-filter" ? "validation" : "task-execution";
                return {
                    ok: false,
                    evidence,
                    errorClass: cls,
                    errorMessage: ex.errorMessage ?? `assistant finish=${ex.finish ?? "none"}`,
                    ...(ex.costUsd !== undefined ? { costUsd: ex.costUsd } : {}),
                    modelCalls,
                };
            }
            finally {
                await hookReg.dispose().catch(() => { });
            }
        }
        catch (e) {
            const cls = classifySessionError(e);
            return { ok: false, evidence: [], errorClass: cls, errorMessage: String(e), modelCalls };
        }
    };
}
/** Best-effort transcript summary for interrupted/aborted turns. */
async function extractSummaryAfterStop(ctx, sessionID) {
    try {
        const context = await ctx.session.context({ sessionID });
        const ex = extractAssistant(context);
        if (!ex.found)
            return [];
        return [{ kind: "log", ref: sessionID, summary: summarizeOutcome(ex.text), ok: false }];
    }
    catch {
        return [];
    }
}
