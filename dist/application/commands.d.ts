/**
 * TITAN command surface (SRS FR-110, FR-007, FR-107).
 *
 * One `/titan` command with subcommands, plus `/titan doctor` as its own entry.
 * This module is pure: it parses input and produces a structured command + a
 * renderer-agnostic result. The plugin entry wires it to OpenCode's command registry.
 *
 * Subcommands (FR-110): plan, run, status, pause, resume, cancel, review, doctor.
 * Extended for usability: tasks, agents, report, approve, reject, help.
 */
export declare const TITAN_SUBCOMMANDS: readonly ["help", "version", "plan", "run", "status", "tasks", "agents", "pause", "resume", "cancel", "review", "verify", "doctor", "approve", "reject", "report", "rpc"];
export type TitanSubcommand = (typeof TITAN_SUBCOMMANDS)[number];
export interface ParsedCommand {
    readonly subcommand: TitanSubcommand;
    readonly args: readonly string[];
    readonly rest: string;
}
export declare class CommandParseError extends Error {
    constructor(message: string);
}
/**
 * Parse a `/titan ...` invocation's argument text.
 * Accepts: "" (help), "status", "run --goal 'X'", etc.
 */
export declare function parseTitanCommand(input: string): ParsedCommand;
/** Result of executing a command — rendered as text by the caller. */
export interface CommandResult {
    readonly ok: boolean;
    readonly text: string;
    /** Optional structured payload for the RPC/TUI layer. */
    readonly data?: unknown;
}
export declare function helpText(): string;
