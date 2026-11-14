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
import { Plugin } from "@opencode/plugin/tui";
declare const _default: Plugin.Definition;
export default _default;
