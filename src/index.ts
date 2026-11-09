/**
 * TITAN plugin entry — OpenCode V2 (SRS FR-001, FR-002, FR-003, FR-006, FR-007,
 * FR-110, FR-050..FR-074).
 *
 * Hard rules (verified in R0/R1, ADR-001/002/005):
 *  - `setup` must NOT await model-driven operations (session.prompt/wait) — it deadlocks
 *    the server. Everything heavy runs fire-and-forget after setup returns.
 *  - Command registrations must stay alive for the plugin lifetime; they are disposed in
 *    the returned cleanup (FR-006). Disposing early makes `session.command` fail with
 *    "Command not found".
 *  - Output is surfaced via `session.synthetic` + immediate `session.interrupt` when idle:
 *    visible in the transcript WITHOUT triggering an unrequested model turn (FR-107,
 *    NFR-006). A busy user session gets `delivery:"queue"` and is never interrupted.
 *
 * R3 wiring: SQLite state (project-scoped file), agent registry + model routing,
 * run manager + orchestrator, and the REAL session executor (worker sessions via
 * prompt/wait; role injection through `session.hook("context")`).
 */
import { Plugin } from "@opencode/plugin"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { parseTitanCommand, helpText, CommandParseError, type CommandResult } from "./application/commands.js"
import { runDoctor, renderDoctor, versionGte, MIN_OPENCODE_VERSION, type DoctorSources } from "./application/doctor.js"
import { SqliteAdapter } from "./reliability/sqlite.js"
import { AgentRegistry } from "./agents/registry.js"
import { ModelRouter, type ModelCandidate } from "./agents/router.js"
import { RunManager } from "./application/run-manager.js"
import { Orchestrator } from "./orchestration/orchestrator.js"
import { createSessionExecutor } from "./execution/session-executor.js"
import { runBlueprint, renderRunStatus } from "./application/playbook.js"
import { verifyExecution } from "./verification/gates.js"

export const TITAN_PLUGIN_ID = "titan.orchestrator"

/** OpenCode versions TITAN is validated against (FR-002). */
export const SUPPORTED_OPENCODE_MIN = MIN_OPENCODE_VERSION

interface Registration {
  dispose: () => Promise<void>
}

/** Live orchestration engine built in setup and handed to command handlers. */
interface TitanEngine {
  readonly ctx: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
  readonly registry: AgentRegistry
  readonly router: ModelRouter
  readonly rm: RunManager
  readonly orch: Orchestrator
}

/** Everything a subcommand handler may use. */
interface HandlerEnv {
  readonly sessionID: string
  readonly display: (text: string) => Promise<void>
  readonly sources: DoctorSources
  readonly opencodeVersion: string
  readonly engine: TitanEngine
  /** Tracks runs currently driven by an orchestration loop (double-start guard + cleanup). */
  readonly liveRuns: Set<string>
}
type Handler = (args: readonly string[], env: HandlerEnv) => Promise<CommandResult>

/** Build the live doctor sources bound to the real plugin `ctx`. */
function makeDoctorSources(ctx: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]): DoctorSources {
  return {
    appVersion: () => ctx.app.version,
    pluginId: () => TITAN_PLUGIN_ID,
    location: () => ({
      directory: ctx.location.directory,
      project: ctx.location.project.id,
    }),
    models: async () => {
      const res = await ctx.model.list()
      return (res.data ?? []).map((m) => ({ providerID: m.providerID, modelID: m.id }))
    },
    storageProbe: async () => {
      const key = "titan/doctor-probe"
      await ctx.storage.set(key, { at: Date.now() })
      const back = await ctx.storage.get(key)
      return back !== undefined
    },
    vcsBranch: async () => {
      try {
        const info = await ctx.vcs.get()
        return info.data?.branch?.current ?? null
      } catch {
        return null
      }
    },
    vcsChangedFiles: async () => {
      try {
        const st = await ctx.vcs.status()
        return (st.data ?? []).length
      } catch {
        return 0
      }
    },
    permissionRuleCount: async (sessionID) => {
      if (!sessionID) throw new Error("no session available to scope the permission check")
      const res = await ctx.permission.list({ sessionID })
      return (res ?? []).length
    },
  }
}

/** Latest run by creation time (list order from the adapter is not guaranteed). */
function latestRun(runs: readonly { id: string; createdAt: number }[]): string | undefined {
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt)
  return sorted[0]?.id
}

/** Subcommand handlers. Unimplemented ones report honestly (never fake success). */
function makeHandlers(): Record<string, Handler> {
  const notImplemented =
    (name: string, phase: string): Handler =>
    async () => ({
      ok: false,
      text: `/titan ${name} — not available in this build yet (planned: ${phase}). Run "/titan help" for available commands.`,
    })

  return {
    help: async () => ({ ok: true, text: helpText() }),

    doctor: async (_args, env) => {
      const checks = await runDoctor(env.sources, { sessionID: env.sessionID })
      return { ok: true, text: renderDoctor(checks), data: checks }
    },

    version: async (_args, env) => ({
      ok: true,
      text: [
        `TITAN plugin: ${TITAN_PLUGIN_ID}`,
        `OpenCode: ${env.opencodeVersion} (requires >= ${SUPPORTED_OPENCODE_MIN})`,
        `Compatibility: ${versionGte(env.opencodeVersion, SUPPORTED_OPENCODE_MIN) ? "SUPPORTED" : "UNSUPPORTED"}`,
      ].join("\n"),
    }),

    // ── R3 handlers ──────────────────────────────────────────────────────────
    plan: async (args, env) => {
      const supervised = args.includes("--supervised") || args.includes("-s")
      const rest = args.filter((a) => a !== "--supervised" && a !== "-s")
      const goal = rest.join(" ").trim()
      if (goal.length === 0) {
        return { ok: false, text: `/titan plan — a goal is required. Example: /titan plan --supervised add a CONTRIBUTING section` }
      }
      const run = await env.engine.rm.createRun({ goal, tasks: runBlueprint(goal), mode: supervised ? "supervised" : "direct" })
      const tasks = await env.engine.rm.getTasks(run.id)
      return {
        ok: true,
        text: [
          `Planned run ${run.id} (${tasks.length} tasks, mode=${run.mode}, workers ≤ ${run.budget.maxConcurrentWorkers}).`,
          ...tasks.map((t, i) => `  ${i + 1}. ${t.title} (${t.type})`),
          `Start it with: /titan run ${run.id}`,
        ].join("\n"),
      }
    },

    run: async (args, env) => {
      const { rm, orch } = env.engine
      let runId = args[0]?.trim() || latestRun(await rm.listRunsByStatus(["CREATED"]))
      if (!runId) return { ok: false, text: `/titan run — no run id given and no planned run found. Use "/titan plan <goal>".` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan run — run not found: ${runId}` }
      if (env.liveRuns.has(runId)) {
        return { ok: true, text: `Run ${runId} is already executing. Check progress: /titan status ${runId}` }
      }
      if (run.status !== "CREATED") {
        return { ok: false, text: `/titan run — run ${runId} is ${run.status}; only CREATED runs can be started.` }
      }

      env.liveRuns.add(runId)
      const session = env.sessionID
      void (async () => {
        try {
          const outcome = await orch.run(runId)
          const view = await rm.progress(runId)
          const tail = renderRunStatus(view, 0)
          await env.display(`TITAN run ${runId} finished: ${outcome}\n${tail}`)
        } catch (e) {
          console.error("[titan] run loop error:", e)
          await env.display(`TITAN run ${runId} failed to execute: ${String(e)}`)
        } finally {
          env.liveRuns.delete(runId)
        }
      })()
      void session

      return {
        ok: true,
        text: `Started run ${runId} (workers ≤ ${run.budget.maxConcurrentWorkers}). Watch: /titan status ${runId}`,
      }
    },

    status: async (args, env) => {
      const { rm, orch } = env.engine
      const runId = args[0]?.trim() || latestRun(await rm.listRuns())
      if (!runId) return { ok: false, text: `/titan status — no run id given and no runs exist. Use "/titan plan <goal>".` }
      const view = await rm.progress(runId)
      return { ok: true, text: renderRunStatus(view, await orch.activeWorkers(runId)) }
    },

    tasks: async (args, env) => {
      const runId = args[0]?.trim() || latestRun(await env.engine.rm.listRuns())
      if (!runId) return { ok: false, text: `/titan tasks — no run id given and no runs exist.` }
      const tasks = await env.engine.rm.getTasks(runId)
      return {
        ok: true,
        text: [`Tasks in ${runId}:`, ...tasks.map((t) => `  [${t.status}] ${t.id} ${t.title} → ${t.assignedRole ?? "unassigned"}`)].join("\n"),
      }
    },

    agents: async (_args, env) => {
      const roles = env.engine.registry.list()
      return {
        ok: true,
        text: [
          `TITAN agent roles (${roles.length}):`,
          ...roles.map((r) => `  ${r.id} — ${r.name}; tools: ${r.allowedTools.join(",")}; fits: ${r.suitableTaskTypes.join(",")}`),
        ].join("\n"),
      }
    },

    pause: async (args, env) => {
      const runId = args[0]?.trim() || latestRun(await env.engine.rm.listRunsByStatus(["RUNNING"]))
      if (!runId) return { ok: false, text: `/titan pause — no executing run found.` }
      if (!env.liveRuns.has(runId)) return { ok: false, text: `/titan pause — run ${runId} is not being driven (maybe finished).` }
      env.engine.orch.pause(runId)
      return { ok: true, text: `Pause requested for ${runId}: no NEW tasks are launched; in-flight tasks finish. Resume: /titan resume ${runId}` }
    },

    resume: async (args, env) => {
      const runId = args[0]?.trim() || latestRun(await env.engine.rm.listRunsByStatus(["RUNNING", "PAUSED"]))
      if (!runId) return { ok: false, text: `/titan resume — no paused/running run found.` }
      env.engine.orch.resume(runId)
      return { ok: true, text: `Resume requested for ${runId}.` }
    },

    cancel: async (args, env) => {
      const { rm, orch } = env.engine
      const runId = args[0]?.trim() || latestRun(await rm.listRunsByStatus(["RUNNING", "PAUSED", "CREATED", "READY", "PREFLIGHT"]))
      if (!runId) return { ok: false, text: `/titan cancel — no cancellable run found.` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan cancel — run not found: ${runId}` }
      if (["FAILED", "CANCELLED", "REJECTED", "CLOSED", "SUCCEEDED"].includes(run.status)) {
        return { ok: false, text: `/titan cancel — run ${runId} is already ${run.status}.` }
      }
      orch.cancel(runId)
      return { ok: true, text: `Cancel requested for ${runId}: in-flight tasks are interrupted and no new tasks start.` }
    },

    // Honest stubs until their phases land — never fake success (brief: no unverified claims).
    review: async (args, env) => {
      const { rm, ctx } = env.engine
      const deep = args.includes("--deep")
      const rest = args.filter((a) => a !== "--deep")
      const runId = rest[0]?.trim() || latestRun(await rm.listRuns())
      if (!runId) return { ok: false, text: `/titan review — no run id given and no runs exist.` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan review — run not found: ${runId}` }
      const tasks = await rm.getTasks(runId)
      const approvals = await rm.listApprovals(runId)
      const total = tasks.length
      const succeeded = tasks.filter((t) => t.status === "SUCCEEDED").length
      const failed = tasks.filter((t) => t.status === "FAILED").length
      const evidenceCount = tasks.reduce((a, t) => a + t.evidence.length, 0)
      const acTotal = tasks.reduce((a, t) => a + t.acceptanceCriteria.length, 0)
      const acRequired = tasks.reduce((a, t) => a + t.acceptanceCriteria.filter((c) => c.evidenceRequired).length, 0)
      const verdict =
        run.status === "CLOSED" && failed === 0 && succeeded === total
          ? "PASS — all tasks succeeded with evidence"
          : failed > 0
            ? `FAIL — ${failed} task(s) failed`
            : `INCOMPLETE — ${succeeded}/${total} tasks succeeded`
      const lines = [
        `TITAN review — ${runId}`,
        `Goal: ${run.goal}`,
        `Run status: ${run.status}  Mode: ${run.mode}`,
        `Verdict: ${verdict}`,
        `Tasks: ${succeeded}/${total} succeeded, ${failed} failed, ${tasks.filter((t) => t.status === "SKIPPED").length} skipped`,
        `Evidence entries: ${evidenceCount}  (AC total ${acTotal}, evidence-required ${acRequired})`,
        `Approvals: ${approvals.length} total, ${approvals.filter((a) => a.status === "approved").length} approved, ${approvals.filter((a) => a.status === "rejected").length} rejected`,
        `Roles: ${[...new Set(tasks.map((t) => t.assignedRole).filter(Boolean))].join(", ") || "none"}`,
      ]

      if (deep) {
        try {
          const model = env.engine.router.route({ taskType: "review", requiresTools: false, allowlist: [], allowFallback: true })
          const sess = await ctx.session.create({
            title: `TITAN review — ${runId}`.slice(0, 120),
            model: { id: model.modelID, providerID: model.providerID },
            metadata: { titan: { runId, deepReview: true } },
          })
          const hook = await ctx.session.hook("context", (input) => {
            if (input.sessionID !== sess.id) return
            input.system.push({ type: "text", text: `You are the "Reviewer" role. Review this run's evidence and produce a one-paragraph verdict.` })
          })
          const brief = [
            `Run ${runId}: ${run.goal}`,
            `Tasks: ${tasks.map((t) => `${t.id} [${t.status}] ${t.title} (role=${t.assignedRole ?? "?"}, evidence=${t.evidence.length})`).join("\\n")}`,
            `Approvals: ${approvals.length}`,
          ].join("\\n")
          await ctx.session.prompt({ sessionID: sess.id, text: brief })
          const wait = ctx.session.wait({ sessionID: sess.id }).then(() => "done" as const)
          const timeout = new Promise<"timeout">((resolve) => { const t = setTimeout(() => resolve("timeout" as const), 120000); if (typeof t === "object" && t) (t as unknown as { unref?: () => void }).unref?.() })
          const end = await Promise.race([wait, timeout])
          if (end === "timeout") await ctx.session.interrupt({ sessionID: sess.id }).catch(() => {})
          const context = await ctx.session.context({ sessionID: sess.id })
          const arr = Array.isArray(context) ? context : ((context as { data?: unknown[] })?.data ?? [])
          const last = [...arr].reverse().find((m) => (m as { type?: string })?.type === "assistant") as { text?: string; content?: { type: string; text?: string }[] } | undefined
          const text = last?.text && last.text.length > 0 ? last.text : (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\\n")
          await hook.dispose().catch(() => {})
          lines.push("", "## Deep review (model-assisted)", "", text.trim().slice(0, 1500) || "(no output)")
        } catch (e) {
          lines.push("", `## Deep review failed: ${String(e)}`)
        }
      } else {
        lines.push("Note: this is an evidence-based review (presence of proof). Run `/titan review --deep` for a model-assisted review.")
      }

      return { ok: true, text: lines.join("\\n") }
    },

    verify: async (args, env) => {
      const { rm } = env.engine
      const runId = args[0]?.trim() || latestRun(await rm.listRuns())
      if (!runId) return { ok: false, text: `/titan verify — no run id given and no runs exist.` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan verify — run not found: ${runId}` }
      const tasks = await rm.getTasks(runId)
      const lines = [`TITAN verify — ${runId}`]
      let pass = 0
      let fail = 0
      for (const t of tasks) {
        const v = verifyExecution(t, { ok: t.status === "SUCCEEDED", evidence: t.evidence.map((e) => ({ kind: e.kind as "diff" | "test" | "log" | "artifact" | "command", ref: e.ref, summary: e.summary, ok: e.ok })) })
        if (v.ok) pass++
        else fail++
        const tag = v.ok ? "PASS" : "FAIL"
        const detail = v.ok ? "" : ` — ${v.issues.join("; ")}`
        lines.push(`  [${tag}] ${t.id} ${t.title}${detail}`)
      }
      lines.push(`Summary: ${pass} PASS, ${fail} FAIL out of ${tasks.length}`)
      return { ok: true, text: lines.join("\\n") }
    },
    approve: async (args, env) => {
      const { rm, orch } = env.engine
      const runId = args[0]?.trim() || latestRun(await rm.listRunsByStatus(["RUNNING", "PAUSED"]))
      if (!runId) return { ok: false, text: `/titan approve — no run id given and no active run found.` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan approve — run not found: ${runId}` }
      const n = await orch.decideApproval(runId, "approved", "human", undefined)
      if (n === 0) return { ok: true, text: `No pending approvals found for ${runId}.` }
      return { ok: true, text: `Approved ${n} pending task(s) in ${runId}; execution resumes on the next scheduler tick.` }
    },

    reject: async (args, env) => {
      const { rm, orch } = env.engine
      const runId = args[0]?.trim() || latestRun(await rm.listRunsByStatus(["RUNNING", "PAUSED"]))
      if (!runId) return { ok: false, text: `/titan reject — no run id given and no active run found.` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan reject — run not found: ${runId}` }
      const n = await orch.decideApproval(runId, "rejected", "human", undefined)
      if (n === 0) return { ok: true, text: `No pending approvals found for ${runId}.` }
      return { ok: true, text: `Rejected ${n} pending task(s) in ${runId}; dependents marked SKIPPED.` }
    },
    report: async (args, env) => {
      const { rm, orch } = env.engine
      const runId = args[0]?.trim() || latestRun(await rm.listRuns())
      if (!runId) return { ok: false, text: `/titan report — no run id given and no runs exist.` }
      const run = await rm.getRun(runId)
      if (!run) return { ok: false, text: `/titan report — run not found: ${runId}` }
      const tasks = await rm.getTasks(runId)
      const approvals = await rm.listApprovals(runId)
      const succeeded = tasks.filter((t) => t.status === "SUCCEEDED").length
      const failed = tasks.filter((t) => t.status === "FAILED").length
      const skipped = tasks.filter((t) => t.status === "SKIPPED").length
      const evidence = tasks.reduce((a, t) => a + t.evidence.length, 0)
      const active = await orch.activeWorkers(runId)
      const lines = [
        `# TITAN Delivery Report`,
        ``,
        `- **Run**: ${run.id}`,
        `- **Goal**: ${run.goal}`,
        `- **Status**: ${run.status}${run.statusReason ? ` (${run.statusReason})` : ""}`,
        `- **Mode**: ${run.mode}`,
        `- **Created**: ${new Date(run.createdAt).toISOString()}`,
        run.closedAt ? `- **Closed**: ${new Date(run.closedAt).toISOString()}` : `- **Closed**: (not yet)`,
        `- **Workers active**: ${active}`,
        ``,
        `## Tasks (${tasks.length})`,
        ``,
        `| # | ID | Title | Type | Status | Role | Evidence |`,
        `|---|---|---|---|---|---|---|`,
        ...tasks.map((t, i) => `| ${i + 1} | ${t.id} | ${t.title} | ${t.type} | ${t.status} | ${t.assignedRole ?? "-"} | ${t.evidence.length} |`),
        ``,
        `## Summary`,
        ``,
        `- Succeeded: ${succeeded}  Failed: ${failed}  Skipped: ${skipped}  Total: ${tasks.length}`,
        `- Evidence entries: ${evidence}`,
        `- Approvals: ${approvals.length} (${approvals.filter((a) => a.status === "approved").length} approved, ${approvals.filter((a) => a.status === "rejected").length} rejected, ${approvals.filter((a) => a.status === "pending").length} pending)`,
        `- Budget: ${run.budget.maxConcurrentWorkers} workers, ${run.budget.maxAttemptsPerTask} attempts/task, ${run.budget.maxTotalSeconds}s wall clock`,
        ``,
        `## Verdict`,
        ``,
        failed === 0 && succeeded === tasks.length && tasks.length > 0
          ? `All ${tasks.length} tasks succeeded. Delivery complete.`
          : failed > 0
            ? `${failed} task(s) failed — review the failures above before delivery.`
            : `${succeeded}/${tasks.length} tasks succeeded; run not yet complete.`,
      ]
      return { ok: true, text: lines.join("\\n") }
    },
  }
}

async function makeEngine(
  ctx: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0],
): Promise<{ engine: TitanEngine; close: () => Promise<void> }> {
  // Durable, project-scoped state (SRS FR-090; recovery on restart feeds on this).
  const db = await SqliteAdapter.open({ file: join(ctx.location.directory, ".titan", "titan.db") })
  const registry = new AgentRegistry()

  // FR-040: route only among models OpenCode actually exposes — never assume.
  const router = new ModelRouter()
  const models = await ctx.model.list()
  const candidates: ModelCandidate[] = (models.data ?? []).map((m) => ({
    providerID: m.providerID,
    modelID: m.id,
  }))
  router.setAvailable(candidates)

  const rm = new RunManager(db, registry)
  const orch = new Orchestrator({
    runManager: rm,
    persistence: db,
    registry,
    router,
    // Real worker sessions (ADR-002 pattern: prompt/wait OUTSIDE setup).
    executor: createSessionExecutor({ ctx, registry }),
    // FR-060: isolated-write roles get a real git worktree via OpenCode V2.
    worktreeForTask: async (task) => {
      try {
        const w = await ctx.worktree.create({ projectID: ctx.location.project.id, name: `titan-${task.id}` })
        return w.directory
      } catch (e) {
        console.error(`[titan] worktree create failed for ${task.id}; worker will run in project directory:`, e)
        return undefined
      }
    },
    // FR-061: merge isolated worktree changes back into the main project tree.
    mergeWorktree: async (workspaceDir) => {
      const mainDir = ctx.location.directory
      try {
        // Commit whatever the worker changed inside the worktree.
        execFileSync("git", ["-C", workspaceDir, "add", "-A"], { stdio: "ignore" })
        execFileSync("git", ["-C", workspaceDir, "commit", "-m", "titan: isolated task changes", "--allow-empty"], { stdio: "ignore" })
        const sha = execFileSync("git", ["-C", workspaceDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
        // Apply the resulting diff to the main tree without committing.
        execFileSync("git", ["-C", mainDir, "cherry-pick", "--no-commit", sha], { stdio: "ignore" })
        execFileSync("git", ["-C", mainDir, "reset", "--mixed", "HEAD"], { stdio: "ignore" })
      } catch (e) {
        console.error(`[titan] mergeWorktree failed for ${workspaceDir}:`, e)
      }
    },
    // FR-060 cleanup: always remove the worktree after the task finishes.
    cleanupWorktree: async (workspaceDir) => {
      try {
        await ctx.worktree.remove({ projectID: ctx.location.project.id, directory: workspaceDir, force: true })
      } catch (e) {
        console.error(`[titan] cleanupWorktree failed for ${workspaceDir}:`, e)
      }
    },
  })
  return { engine: { ctx, registry, router, rm, orch }, close: () => db.close() }
}

export default Plugin.define({
  id: TITAN_PLUGIN_ID,
  async setup(ctx) {
    const startedAt = Date.now()
    const versionOk = versionGte(ctx.app.version, SUPPORTED_OPENCODE_MIN)

    // FR-002: never hide an unsupported mode — loud at startup, and doctor reports FAIL.
    if (!versionOk) {
      console.error(
        `[titan] UNSUPPORTED OpenCode ${ctx.app.version} (requires >= ${SUPPORTED_OPENCODE_MIN}). ` +
          `TITAN registration continues so /titan doctor can report the failure — do not rely on orchestration.`,
      )
    } else {
      console.log(`[titan] ${TITAN_PLUGIN_ID} loaded on OpenCode ${ctx.app.version} (${Date.now() - startedAt}ms)`)
    }

    const { engine, close } = await makeEngine(ctx)
    const sources = makeDoctorSources(ctx)
    const handlers = makeHandlers()
    const liveRuns = new Set<string>()
    const registrations: Registration[] = []

    /**
     * Surface command output to the user WITHOUT hijacking the session (SRS FR-107:
     * status display must not unexpectedly take over the user's session; NFR-006: local
     * display must not depend on model latency).
     *
     * Verified empirically against OpenCode 2.2.5 (see docs/DECISIONS/ADR-005):
     *  - `session.synthetic` (visible in transcript) triggers a model turn by default.
     *  - Message commits to the transcript at ~40ms; first model output at ~3.4s —
     *    so: inject → poll until visible → interrupt. The model turn is cancelled inside
     *    a ~3.3s safety window, leaving the message visible with zero model tokens.
     *  - Interrupting BEFORE commit cancels delivery (message stuck in inbox, invisible),
     *    which is why we poll for visibility instead of a fixed delay.
     *  - `resume:false` hides the message in the inbox — unusable for display.
     *  - If the user's own run is in flight (time.busy > time.idle), we queue instead of
     *    interrupting — killing their run would be the very takeover FR-107 forbids.
     */
    async function display(sessionID: string, text: string): Promise<void> {
      if (!/^ses_/.test(sessionID)) {
        // No usable session (e.g. dispatch outside a session) — never lose output silently.
        console.log(`[titan]\n${text}`)
        return
      }
      try {
        const info = await ctx.session.get({ sessionID })
        const t = info.time
        const busy = t.busy !== undefined && (t.idle === undefined || t.busy > t.idle)
        if (busy) {
          await ctx.session.synthetic({ sessionID, text, description: "TITAN", delivery: "queue" })
          return
        }

        await ctx.session.synthetic({ sessionID, text, description: "TITAN" })

        // Poll until the message is committed to the transcript (measured ~40ms), max 1s.
        const needle = text.slice(0, 60)
        const deadline = Date.now() + 1000
        let committed = false
        while (Date.now() < deadline && !committed) {
          const ctxMsgs = await ctx.session.context({ sessionID })
          const arr: readonly unknown[] = Array.isArray(ctxMsgs)
            ? ctxMsgs
            : (((ctxMsgs as { messages?: readonly unknown[] }).messages) ?? [])
          committed = arr.some((m) => {
            const o = m as Record<string, unknown>
            const tx = typeof o?.text === "string" ? o.text : undefined
            return typeof tx === "string" && tx.includes(needle)
          })
          if (!committed) await new Promise((r) => setTimeout(r, 30))
        }

        const res = await ctx.session.interrupt({ sessionID })
        if (!committed) {
          // Should not happen (window is ~3.3s): keep output visible via log fallback.
          console.error(`[titan] display message did not commit within 1s; output logged instead`)
          console.log(`[titan]\n${text}`)
        } else if (res.interrupted) {
          console.log(`[titan] display injected; suppressed unrequested model turn`)
        }
      } catch (e) {
        console.error(`[titan] display failed: ${String(e)}`)
        console.log(`[titan]\n${text}`)
      }
    }

    /**
     * The single command pipeline: parse args → run handler → display output.
     * Used by both `/titan ...` and `/titan-doctor` (fire-and-forget; never blocks dispatch).
     */
    function runPipeline(sessionID: string, rawText: string): void {
      void (async () => {
        const env: HandlerEnv = {
          sessionID,
          display: (text) => display(sessionID, text),
          sources,
          opencodeVersion: ctx.app.version,
          engine,
          liveRuns,
        }
        try {
          const parsed = parseTitanCommand(rawText)
          const handler = handlers[parsed.subcommand]
          if (!handler) {
            await env.display(`Unknown /titan subcommand "${parsed.subcommand}". Try "/titan help".`)
            return
          }
          const result = await handler(parsed.args, env)
          if (result.text) await env.display(result.text)
        } catch (e) {
          if (e instanceof CommandParseError) {
            await env.display(`${e.message}`)
          } else {
            await env.display(`/titan failed: ${String(e)}`)
            console.error("[titan] command error:", e)
          }
        }
      })()
    }

    // FR-110: /titan + subcommands. Registration stays alive until cleanup (FR-006).
    // Awaiting transform is a local registry op (not model-driven) — safe in setup (ADR-002).
    const cmdReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "titan",
        description: "TITAN multi-agent orchestration (plan, run, status, doctor, ...)",
        execute: async (inv) => runPipeline(inv.sessionID, inv.prompt.text),
      })
    })
    registrations.push(cmdReg)

    // FR-007: /titan doctor as its own entry point (same pipeline, no subcommand needed).
    const doctorReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "titan-doctor",
        description: "Diagnose TITAN/OpenCode compatibility, models, storage, git, permissions (FR-007)",
        execute: async (inv) => runPipeline(inv.sessionID, "doctor"),
      })
    })
    registrations.push(doctorReg)

    console.log(`[titan] registered commands: /titan, /titan-doctor`)

    // FR-006: idempotent cleanup — stop orchestration loops and dispose registrations.
    let cleaned = false
    return async () => {
      if (cleaned) return
      cleaned = true
      for (const runId of liveRuns) engine.orch.cancel(runId)
      for (const reg of registrations) {
        try {
          await reg.dispose()
        } catch (e) {
          console.error("[titan] cleanup dispose failed:", e)
        }
      }
      await close().catch((e) => console.error("[titan] db close failed:", e))
      console.log(`[titan] cleanup complete (${registrations.length} registration(s) disposed)`)
    }
  },
})
