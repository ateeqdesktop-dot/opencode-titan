/**
 * TITAN plugin entry — OpenCode V2 (SRS FR-001, FR-002, FR-003, FR-006, FR-007, FR-110).
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
 */
import { Plugin } from "@opencode/plugin"
import { parseTitanCommand, helpText, CommandParseError, type CommandResult } from "./application/commands.js"
import { runDoctor, renderDoctor, versionGte, MIN_OPENCODE_VERSION, type DoctorSources } from "./application/doctor.js"

export const TITAN_PLUGIN_ID = "titan.orchestrator"

/** OpenCode versions TITAN is validated against (FR-002). */
export const SUPPORTED_OPENCODE_MIN = MIN_OPENCODE_VERSION

interface Registration {
  dispose: () => Promise<void>
}

/** Everything a subcommand handler may use. */
interface HandlerEnv {
  readonly sessionID: string
  readonly display: (text: string) => Promise<void>
  readonly sources: DoctorSources
  readonly opencodeVersion: string
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

/** Subcommand handlers implemented in this build. Unimplemented ones report honestly. */
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

    // Honest stubs until their phases land — never fake success (brief: no unverified claims).
    plan: notImplemented("plan", "R2/R3 planning engine"),
    run: notImplemented("run", "R3 run scheduler"),
    status: notImplemented("status", "R2 run/task state + persistence"),
    tasks: notImplemented("tasks", "R2 run/task state + persistence"),
    agents: notImplemented("agents", "R3 agent registry + sessions"),
    pause: notImplemented("pause", "R3 scheduler control"),
    resume: notImplemented("resume", "R3 scheduler control"),
    cancel: notImplemented("cancel", "R3 scheduler control"),
    review: notImplemented("review", "R4 verification engine"),
    verify: notImplemented("verify", "R4 verification gates"),
    approve: notImplemented("approve", "R4 approval workflow"),
    reject: notImplemented("reject", "R4 approval workflow"),
    report: notImplemented("report", "R5 delivery report"),
  }
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

    const sources = makeDoctorSources(ctx)
    const handlers = makeHandlers()
    const registrations: Registration[] = []

    /**
     * Surface command output to the user WITHOUT hijacking the session (SRS FR-107:
     * status display must not unexpectedly take over the user's session; NFR-006: local
     * display must not depend on model latency).
     *
     * Verified empirically against OpenCode 2.2.5:
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
            const tx = (m as { text?: unknown }).text
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

    // FR-006: idempotent cleanup — stop timers/workers and dispose registrations.
    let cleaned = false
    return async () => {
      if (cleaned) return
      cleaned = true
      for (const reg of registrations) {
        try {
          await reg.dispose()
        } catch (e) {
          console.error("[titan] cleanup dispose failed:", e)
        }
      }
      console.log(`[titan] cleanup complete (${registrations.length} registration(s) disposed)`)
    }
  },
})
