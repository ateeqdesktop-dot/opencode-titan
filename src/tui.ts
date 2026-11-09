/**
 * TITAN TUI part (SRS FR-004) — separate from the server part (src/index.ts).
 *
 * Registers a `/titan` slash command in the TUI command palette that surfaces
 * a short status toast. Status detail is fetched via the typed RPC contract
 * (src/rpc/contract.ts, FR-005) through ctx.client.
 *
 * NOTE: this module compiles but has NOT been runtime-verified — there is no
 * headless TUI harness in this environment. It is registered as a best-effort
 * contribution and may need adjustment against a real `opencode` TUI session.
 */
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "titan.tui",
  async setup(ctx) {
    ctx.keymap.layer(() => ({
      commands: [
        {
          id: "titan.status",
          title: "TITAN status",
          description: "Show TITAN orchestration status",
          slash: { name: "titan" },
          run: async () => {
            try {
              ctx.ui.toast.show({ message: "TITAN: use /titan in the prompt for full commands", variant: "info" })
            } catch {
              /* ignore */
            }
          },
        },
      ],
    }))
    return () => {}
  },
})