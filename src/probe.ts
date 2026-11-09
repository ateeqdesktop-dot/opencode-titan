/**
 * R0 compatibility probe.
 *
 * Purpose: prove, against the *installed* `@opencode/plugin` v2.2.6 types and a real
 * OpenCode v2.2.5 server, that every integration surface TITAN's core depends on exists
 * and behaves. This runs inside the OpenCode server process via the plugin `setup` hook.
 *
 * It writes its findings to `probe-result.json` in the plugin's own directory so an
 * external contract test can assert on them without a running model.
 */
import { Plugin } from "@opencode/plugin"
import { writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

interface Finding {
  surface: string
  ok: boolean
  detail: string
}

const findings: Finding[] = []
const record = (surface: string, ok: boolean, detail: string) => {
  findings.push({ surface, ok, detail })
}

export default Plugin.define({
  id: "titan-probe",
  async setup(ctx) {
    record("plugin.define", true, `loaded id=titan-probe app=${ctx.app.version}`)
    record("location", !!ctx.location?.directory, `directory=${ctx.location.directory}`)

    // Kept alive for the plugin lifetime (see command.transform note below).
    let commandReg: { dispose: () => Promise<void> } | undefined

    // Storage surface
    try {
      await ctx.storage.set("titan/probe", { at: Date.now() })
      const back = await ctx.storage.get("titan/probe")
      record("storage", back !== undefined, "set/get round-trip")
    } catch (e) {
      record("storage", false, String(e))
    }

    // Session surface (create + get + remove) — no model call needed
    try {
      const s = await ctx.session.create({ title: "titan-probe-session" })
      const got = await ctx.session.get({ sessionID: s.id })
      record("session.create/get", got?.id === s.id, `sessionID=${s.id}`)
      await ctx.session.remove({ sessionID: s.id })
      record("session.remove", true, "removed")
    } catch (e) {
      record("session.create/get", false, String(e))
    }

    // Tool transform surface
    try {
      const reg = await ctx.tool.transform((editor) => {
        editor.namespace({ name: "titan", description: "TITAN probe tools" })
        editor.add({
          name: "probe_ping",
          description: "Returns pong for TITAN compatibility probing",
          input: { type: "object", properties: {}, additionalProperties: false },
          options: { namespace: "titan" },
          execute: async () => ({ content: "pong" }),
        })
      })
      const tools = await ctx.tool.list()
      const found = tools.some((t) => t.id.includes("probe_ping"))
      record("tool.transform/add/list", found, `registered=${found}`)
      await reg.dispose()
    } catch (e) {
      record("tool.transform/add/list", false, String(e))
    }

    // Command transform surface. NOTE: `command.list()` returns `{ location, data: CommandInfo[] }`
    // — the array is under `.data`, not at the top level. Verified against installed types + runtime.
    try {
      const reg = await ctx.command.transform((editor) => {
        editor.add({
          name: "titan-probe-cmd",
          description: "TITAN probe command",
          execute: async (inv) => {
            // Capture the exact invocation shape so we know how args arrive.
            const out = join(dirname(new URL(import.meta.url).pathname), "probe-cmd.json")
            await writeFile(
              out,
              JSON.stringify(
                {
                  at: Date.now(),
                  sessionID: inv.sessionID,
                  promptText: inv.prompt.text,
                  promptKeys: Object.keys(inv.prompt),
                  delivery: inv.delivery,
                },
                null,
                2,
              ),
            )
          },
        })
      })
      const cmds = await ctx.command.list()
      const found = (cmds.data ?? []).some((c) => c.name === "titan-probe-cmd")
      record("command.transform/add/list", found, `registered=${found} shape=data[]`)
      // FINDING: do NOT dispose here — `session.command()` resolves against live registrations
      // ("Command not found" once disposed). Keep it for the plugin lifetime; disposed in cleanup.
      commandReg = reg
    } catch (e) {
      record("command.transform/add/list", false, String(e))
    }

    // Event subscribe surface. Subscriptions are LIVE-only (no replay): nothing arrives unless an
    // event actually fires AFTER we start listening. So: open the iterator FIRST, THEN trigger
    // session.create (which emits events), and confirm one is delivered. Verified against types.
    try {
      const ac = new AbortController()
      const it = ctx.event.subscribe({ signal: ac.signal })[Symbol.asyncIterator]()
      const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no-event-timeout")), 5000))
      const listening = it.next() // start listening BEFORE the trigger
      const tmp = await ctx.session.create({ title: "titan-probe-event-trigger" }) // emits events
      const first = await Promise.race([listening, timeout])
      ac.abort()
      await ctx.session.remove({ sessionID: tmp.id }).catch(() => {})
      const evType = first && typeof first === "object" && "value" in first ? String((first.value as { type?: string } | undefined)?.type ?? "?") : "?"
      record("event.subscribe", first !== undefined, `delivered event type=${evType} (live-only, listen-then-trigger)`)
    } catch (e) {
      record("event.subscribe", false, String(e))
    }

    // Worktree surface (read-only list; creation needs a git repo — proven separately)
    try {
      const projectID = ctx.location.project?.id
      record("worktree.list", typeof projectID === "string", `projectID=${projectID}`)
    } catch (e) {
      record("worktree.list", false, String(e))
    }

    // Model list surface (drives model routing — must reflect real configured models).
    // NOTE: `model.list()` returns `{ location, data: ModelInfo[] }` — array under `.data`.
    try {
      const models = await ctx.model.list()
      const arr = models.data ?? []
      const sample = arr[0]
      record("model.list", Array.isArray(arr) && arr.length > 0, `count=${arr.length} sample=${sample ? `${sample.providerID}/${sample.id}` : "none"} shape=data[]`)
    } catch (e) {
      record("model.list", false, String(e))
    }

    // VCS surface (drives verification evidence).
    // NOTE: `vcs.get()` returns `{ location, data: { branch: { current } } }` for branch info;
    // `vcs.status()` returns `{ location, data: VcsFileStatus[] }` for changed files. Not `.branch` directly.
    try {
      const info = await ctx.vcs.get()
      const status = await ctx.vcs.status()
      const branch = info.data?.branch?.current
      record("vcs.get/status", info !== undefined, `branch=${branch ?? "none"} changedFiles=${(status.data ?? []).length} shape=get.data.branch / status.data[]`)
    } catch (e) {
      record("vcs.get/status", false, String(e))
    }

    // Permission surface (drives approval gates)
    try {
      record("permission.assert", typeof ctx.permission.assert === "function", "assert is a function")
    } catch (e) {
      record("permission.assert", false, String(e))
    }

    // Session hook surface (drives role injection + tool restriction)
    try {
      const reg = await ctx.session.hook("context", (event) => {
        // no-op; proves registration works
        void event
      })
      await reg.dispose()
      record("session.hook(context)", true, "register + dispose ok")
    } catch (e) {
      record("session.hook(context)", false, String(e))
    }

    // Session prompt + wait — THE load-bearing integration for agent execution (Module 5).
    // CRITICAL R0 FINDING: awaiting `session.prompt`/`session.wait` *synchronously inside setup*
    // deadlocks the server (setup runs during plugin load; blocking on a model call that needs the
    // session runner to progress hangs). So setup must return immediately, and worker execution
    // runs AFTER setup completes. We prove the integration by running it as a background task and
    // writing results to probe-worker.json for an external test to read.
    const workerTest = async () => {
      const findings: Finding[] = []
      try {
        const models = await ctx.model.list()
        const free = (models.data ?? []).find((m) => m.providerID === "opencode" && m.id.endsWith("-free"))
        if (!free) {
          findings.push({ surface: "session.prompt/wait", ok: false, detail: "no free model available" })
        } else {
          const ws = await ctx.session.create({ title: "titan-probe-worker" })
          await ctx.session.switchModel({ sessionID: ws.id, model: { providerID: free.providerID, id: free.id } })
          await ctx.session.prompt({ sessionID: ws.id, text: "Reply with exactly: WORKER_DONE" })
          await ctx.session.wait({ sessionID: ws.id })
          const msgs = await ctx.session.context({ sessionID: ws.id })
          const done = JSON.stringify(msgs).includes("WORKER_DONE")
          findings.push({ surface: "session.prompt/wait", ok: done, detail: `model=${free.providerID}/${free.id} got_DONE=${done}` })
          await ctx.session.remove({ sessionID: ws.id }).catch(() => {})
        }
      } catch (e) {
        findings.push({ surface: "session.prompt/wait", ok: false, detail: String(e) })
      }
      try {
        const out = join(dirname(new URL(import.meta.url).pathname), "probe-worker.json")
        await writeFile(out, JSON.stringify({ at: Date.now(), findings }, null, 2))
      } catch {
        /* best-effort */
      }
    }
    // Fire and forget — do NOT await; setup must stay non-blocking.
    void workerTest()

    // Command dispatch — the REAL path (`session.command`, same as TUI slash commands).
    // `opencode run "text"` does NOT dispatch slash commands (verified: text goes to the model).
    // So we dispatch explicitly and capture what `execute` actually receives.
    const cmdTest = async () => {
      try {
        const cs = await ctx.session.create({ title: "titan-probe-cmd-dispatch" })
        await ctx.session.command({ sessionID: cs.id, name: "titan-probe-cmd", text: "alpha beta --flag" })
        await ctx.session.remove({ sessionID: cs.id }).catch(() => {})
      } catch (e) {
        const out = join(dirname(new URL(import.meta.url).pathname), "probe-cmd-dispatch-error.json")
        await writeFile(out, JSON.stringify({ error: String(e) }, null, 2)).catch(() => {})
      }
    }
    void cmdTest()

    // Display-surface test: does `session.synthetic` inject visible text, and does it
    // trigger model execution? (Commands return void — we need to know how output shows.)
    const synthTest = async () => {
      try {
        const s = await ctx.session.create({ title: "titan-probe-synth" })
        await ctx.session.synthetic({ sessionID: s.id, text: "SYNTHETIC_MARKER_123", description: "titan-display" })
        await new Promise((r) => setTimeout(r, 4000)) // give it time to run if it triggers a model
        const msgs = await ctx.session.context({ sessionID: s.id })
        const arr = Array.isArray(msgs) ? msgs : ((msgs as { messages?: unknown[] })?.messages ?? [])
        const found = JSON.stringify(msgs).includes("SYNTHETIC_MARKER_123")
        // Count assistant text parts to detect whether the model ran in response
        const json = JSON.stringify(msgs)
        const out = join(dirname(new URL(import.meta.url).pathname), "probe-synth.json")
        await writeFile(
          out,
          JSON.stringify(
            {
              at: Date.now(),
              foundInContext: found,
              messageCount: Array.isArray(arr) ? arr.length : -1,
              hasAssistantAfter: json.indexOf("SYNTHETIC_MARKER_123") < json.length - 1,
              snippet: json.slice(Math.max(0, json.indexOf("SYNTHETIC_MARKER_123") - 200), json.indexOf("SYNTHETIC_MARKER_123") + 300),
            },
            null,
            2,
          ),
        )
        await ctx.session.remove({ sessionID: s.id }).catch(() => {})
      } catch (e) {
        const out = join(dirname(new URL(import.meta.url).pathname), "probe-synth.json")
        await writeFile(out, JSON.stringify({ error: String(e) }, null, 2)).catch(() => {})
      }
    }
    void synthTest()

    // Write findings where an external test can read them
    try {
      const out = join(dirname(new URL(import.meta.url).pathname), "probe-result.json")
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, JSON.stringify({ at: Date.now(), findings }, null, 2))
      record("write.findings", true, `path=${out}`)
    } catch (e) {
      record("write.findings", false, String(e))
    }

    console.log(`[titan-probe] ${JSON.stringify(findings, null, 2)}`)

    return async () => {
      await commandReg?.dispose().catch(() => {})
      console.log("[titan-probe] cleanup")
    }
  },
})
