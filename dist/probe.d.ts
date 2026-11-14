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
import { Plugin } from "@opencode/plugin";
declare const _default: Plugin.Plugin;
export default _default;
