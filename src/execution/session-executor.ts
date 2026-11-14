/**
 * Real TaskExecutor — binds TITAN tasks to actual OpenCode worker sessions
 * (SRS §5.4, FR-060..FR-074, FR-031, ADR-002/ADR-003).
 *
 * Flow per task:
 *   1. create a dedicated worker session (titled, model-routed, permission-scoped,
 *      located in the task worktree when the role requires isolated writes)
 *   2. deny interactive tools the role's policy forbids (FR-100/101, least privilege)
 *   3. register `session.hook("context")` to inject the ROLE as a system part
 *      (ADR-003 — roles are TITAN domain data, not OpenCode agents) and dispose it
 *      when the turn completes so it cannot leak into later sessions
 *   4. prompt the task brief, wait for idle (experimental `session.wait`), with
 *      task timeout + orchestration abort handled by interrupting the session
 *   5. extract the last assistant message (text/finish/tokens/cost) from
 *      `session.context` as the execution result
 *   6. on retryable model errors (FR-044), fall back to the routed fallback model
 *      once, recording the extra attempt in evidence + model-call budget
 *
 * This module performs REAL work — no mocks. Worker conversations consume model
 * calls and produce real output in the selected workspace.
 */
import type { TaskExecutionContext, TaskExecutor, TaskExecutionResult } from "../orchestration/orchestrator.js"
import type { AgentRole, ErrorClass, Task } from "../domain/types.js"
import type { AgentRegistry } from "../agents/registry.js"
import type { PluginCtx } from "../platform/opencode.js"

// ── Pure, unit-testable policy helpers ───────────────────────────────────────

/** Interactive tools a session could use to mutate state or reach outside. */
const INTERACTIVE_TOOLS = ["write", "edit", "bash", "webfetch"] as const

/**
 * Which interactive tools must be denied for this role's session, per the
 * least-privilege rule (FR-100/101): every interactive tool outside
 * `role.allowedTools` is denied with a session-scoped permission.
 */
export function deniedToolsForRole(role: AgentRole): readonly string[] {
  return INTERACTIVE_TOOLS.filter((t) => !(role.allowedTools as readonly string[]).includes(t))
}

/**
 * Build the ADR-003 role-injection system part: who the worker is, what it may
 * touch, and how it must behave. Deterministic text derived from registry data.
 */
export function roleSystemText(role: AgentRole, goal: string): string {
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
  ]
  return lines.filter((l): l is string => l !== null).join("\n")
}

/** The user prompt that carries the task into the worker session. */
export function taskPromptText(task: Task, goal: string): string {
  const ac = task.acceptanceCriteria.length
    ? `\nAcceptance criteria:\n${task.acceptanceCriteria
        .map((a) => `- [${a.id}] ${a.statement}${a.evidenceRequired ? " (evidence required)" : ""}`)
        .join("\n")}`
    : ""
  const deps = task.inputArtifactIds.length ? `\nRelevant artifacts: ${task.inputArtifactIds.join(", ")}` : ""
  return [
    `TITAN task ${task.id} (${task.type}, priority ${task.priority}).`,
    `Run goal: ${goal}`,
    `Task title: ${task.title}`,
    task.description ?? null,
    deps,
    ac,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
}

/** Classify an unexpected error for the retry engine (SRS §12.1). */
export function classifySessionError(e: unknown): ErrorClass {
  const msg = String(e).toLowerCase()
  if (msg.includes("rate") || msg.includes("429") || msg.includes("too many requests") || msg.includes("insufficient") || msg.includes("funds") || msg.includes("quota")) return "rate-limit"
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("aborted")) return "session"
  if (msg.includes("network") || msg.includes("econn") || msg.includes("fetch failed")) return "network"
  if (msg.includes("permission") || msg.includes("403")) return "permission"
  if (msg.includes("model") || msg.includes("provider")) return "provider"
  return "task-execution"
}

// ── Structured view of the assistant output (defensive REST shapes) ──────────

export interface AssistantExtract {
  readonly found: boolean
  readonly finish?: string
  readonly text: string
  readonly outputTokens?: number
  readonly costUsd?: number
  readonly errorMessage?: string
}

/** Pull the LAST assistant message out of a `session.context` payload. */
export function extractAssistant(payload: unknown): AssistantExtract {
  const arr: readonly unknown[] = Array.isArray(payload)
    ? payload
    : ((payload as { data?: unknown[] })?.data ?? (payload as { messages?: unknown[] })?.messages ?? [])
  let last: Record<string, unknown> | undefined
  for (const m of arr) {
    const o: Record<string, unknown> | null = m && typeof m === "object" ? (m as Record<string, unknown>) : null
    if (o && o.type === "assistant") last = o
  }
  if (!last) return { found: false, text: "" }

  const text =
    typeof last.text === "string" && last.text.length > 0
      ? last.text
      : Array.isArray(last.content)
        ? (last.content as readonly unknown[])
            .filter((c) => (c as { type?: string } | null)?.type === "text")
            .map((c) => (c as { text?: string } | null)?.text ?? "")
            .filter((t) => t.length > 0)
            .join("\n")
        : ""

  const tokens = last.tokens as { output?: number } | undefined
  const cost = typeof last.cost === "number" ? last.cost : undefined
  const err = last.error

  let errorMessage: string | undefined
  if (typeof err === "string" && err.length > 0) errorMessage = err
  else if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string")
    errorMessage = (err as { message: string }).message

  return {
    found: true,
    text,
    ...(typeof last.finish === "string" ? { finish: last.finish } : {}),
    ...(tokens && typeof tokens.output === "number" ? { outputTokens: tokens.output } : {}),
    ...(cost !== undefined ? { costUsd: cost } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  }
}

/** One-line outcome: prefer the explicit `TITAN_RESULT:` line, else the last text line. */
export function summarizeOutcome(text: string): string {
  const lines = text.split(/\r?\n/)
  const hit = lines.find((l) => /TITAN_RESULT:/.test(l))
  const base =
    hit ?? [...lines].reverse().find((l) => l.trim().length > 0) ?? "worker returned no text"
  return base.trim().slice(0, 240)
}

// ── Executor ─────────────────────────────────────────────────────────────────

export interface SessionExecutorOptions {
  readonly ctx: PluginCtx
  /** Resolves the role id to its full definition (ADR-003 injection payload). */
  readonly registry: AgentRegistry
  /** Fallback single-task cap (ms) when TaskLimits.timeoutSeconds is unset/0. */
  readonly defaultTimeoutMs?: number
}

export function createSessionExecutor(o: SessionExecutorOptions): TaskExecutor {
  return async (exe: TaskExecutionContext): Promise<TaskExecutionResult> => {
    const { run, task, model, workspaceDir, signal } = exe
    const role: AgentRole = o.registry.get(exe.role)
    const ctx = o.ctx
    const timeoutMs = task.limits.timeoutSeconds * 1000 || o.defaultTimeoutMs || 30 * 60 * 1000
    const permissions = deniedToolsForRole(role).map((tool) => ({
      action: tool,
      resource: "*",
      effect: "deny" as const,
    }))

    let modelCalls = 0
    let usedFallback = false
    let sessionID: string | undefined

    const createOne = (m: { modelID: string; providerID: string }) =>
      ctx.session.create({
        title: `TITAN ${task.id} — ${task.title}`.slice(0, 120),
        model: { id: m.modelID, providerID: m.providerID },
        ...(workspaceDir ? { location: { directory: workspaceDir } } : {}),
        ...(permissions.length > 0 ? { permissions } : {}),
        metadata: { titan: { run: task.runId, task: task.id, role: role.id, goal: run.goal } },
      })

    try {
      // 1. Create the session (once; on retryable provider failure → fallback, FR-044).
      try {
        const created = await createOne({ modelID: model.modelID, providerID: model.providerID })
        sessionID = created.id
        modelCalls++
      } catch (e) {
        const fb = model.fallback
        const cls = classifySessionError(e)
        if (!fb || (cls !== "rate-limit" && cls !== "network" && cls !== "provider")) throw e
        console.error(`[titan] session create failed (${cls}); falling back to ${fb.providerID}/${fb.modelID}`)
        const created = await createOne({ modelID: fb.modelID, providerID: fb.providerID })
        sessionID = created.id
        modelCalls += 2
        usedFallback = true
      }
      if (!sessionID) throw new Error("session create returned no id")
      const sid = sessionID

      // 2. ADR-003 role injection — one system part per model request for this session.
      const hookReg = await ctx.session.hook("context", (input) => {
        if (input.sessionID !== sid) return
        input.system.push({ type: "text", text: roleSystemText(role, run.goal) })
      })

      try {
        // 3. Real task work: one prompt → one complete model turn.
        await ctx.session.prompt({ sessionID: sid, text: taskPromptText(task, run.goal) })

        // 4. Wait for idle; race against task timeout and orchestration abort.
        const wait: Promise<"done"> = ctx.session.wait({ sessionID: sid }).then(() => "done" as const)
        const timeout: Promise<"timeout"> = new Promise((resolve) => {
          const t = setTimeout(() => resolve("timeout" as const), timeoutMs)
          if (typeof t === "object" && t !== null) (t as unknown as { unref?: () => void }).unref?.()
        })
        const aborted: Promise<"aborted"> = new Promise((resolve) => {
          if (signal.aborted) resolve("aborted" as const)
          else signal.addEventListener("abort", () => resolve("aborted" as const), { once: true })
        })

        const end = await Promise.race([wait, timeout, aborted])
        if (end === "timeout" || end === "aborted") {
          await ctx.session.interrupt({ sessionID: sid }).catch(() => {})
          if (end === "timeout") {
            const ex = extractSummaryAfterStop(ctx, sid)
            const evidence = await ex
            return { ok: false, evidence, errorClass: "session", errorMessage: `task exceeded ${timeoutMs}ms`, modelCalls }
          }
          const evidence = await extractSummaryAfterStop(ctx, sid)
          return { ok: false, evidence, errorClass: "session", errorMessage: "cancelled", modelCalls }
        }

        // 5. Judge the finished turn from the transcript.
        const context = await ctx.session.context({ sessionID: sid })
        const ex = extractAssistant(context)
        if (!ex.found) {
          return { ok: false, evidence: [], errorClass: "session", errorMessage: "no assistant message found after wait", modelCalls }
        }
        const summary = summarizeOutcome(ex.text)
        const evidence: TaskExecutionResult["evidence"] = [
          { kind: "log", ref: sid, summary, ok: ex.finish === "stop" },
        ]
        if (ex.finish === "stop") {
          return {
            ok: true,
            evidence,
            ...(ex.costUsd !== undefined ? { costUsd: ex.costUsd } : {}),
            modelCalls,
          }
        }
        const cls: ErrorClass =
          ex.finish === "error" ? "provider" : ex.finish === "content-filter" ? "validation" : "task-execution"
        return {
          ok: false,
          evidence,
          errorClass: cls,
          errorMessage: ex.errorMessage ?? `assistant finish=${ex.finish ?? "none"}`,
          ...(ex.costUsd !== undefined ? { costUsd: ex.costUsd } : {}),
          modelCalls,
        }
      } finally {
        await hookReg.dispose().catch(() => {})
      }
    } catch (e) {
      const cls = classifySessionError(e)
      return { ok: false, evidence: [], errorClass: cls, errorMessage: String(e), modelCalls }
    }
  }
}

/** Best-effort transcript summary for interrupted/aborted turns. */
async function extractSummaryAfterStop(ctx: PluginCtx, sessionID: string): Promise<TaskExecutionResult["evidence"]> {
  try {
    const context = await ctx.session.context({ sessionID })
    const ex = extractAssistant(context)
    if (!ex.found) return []
    return [{ kind: "log", ref: sessionID, summary: summarizeOutcome(ex.text), ok: false }]
  } catch {
    return []
  }
}
