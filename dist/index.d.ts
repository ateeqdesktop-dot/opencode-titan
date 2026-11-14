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
import { Plugin } from "@opencode/plugin";
export declare const TITAN_PLUGIN_ID = "titan.orchestrator";
/** OpenCode versions TITAN is validated against (FR-002). */
export declare const SUPPORTED_OPENCODE_MIN = "2.0.0";
declare const _default: Plugin.Plugin;
export default _default;
