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
export const TITAN_SUBCOMMANDS = [
    "help",
    "version",
    "plan",
    "run",
    "status",
    "tasks",
    "agents",
    "pause",
    "resume",
    "cancel",
    "review",
    "verify",
    "doctor",
    "approve",
    "reject",
    "report",
    "rpc",
];
export class CommandParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "CommandParseError";
    }
}
/**
 * Parse a `/titan ...` invocation's argument text.
 * Accepts: "" (help), "status", "run --goal 'X'", etc.
 */
export function parseTitanCommand(input) {
    const trimmed = input.trim();
    if (trimmed === "") {
        return { subcommand: "help", args: [], rest: "" };
    }
    // First whitespace-delimited token is the subcommand; the rest is passed through.
    const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
    if (!m || !m[1])
        return { subcommand: "help", args: [], rest: "" };
    const word = m[1];
    const rest = m[2] ?? "";
    const lower = word.toLowerCase();
    if (!TITAN_SUBCOMMANDS.includes(lower)) {
        throw new CommandParseError(`Unknown /titan subcommand "${word}". Try: ${TITAN_SUBCOMMANDS.join(", ")}`);
    }
    return { subcommand: lower, args: rest.trim().length ? rest.trim().split(/\s+/) : [], rest: rest.trim() };
}
export function helpText() {
    return [
        "TITAN — Multi-Agent Engineering Orchestration for OpenCode V2",
        "",
        "Usage: /titan <subcommand> [args]",
        "",
        "  plan      Analyze a request and produce an execution plan / DAG",
        "  run       Start (or resume) an execution run",
        "  status    Show current run/task/worker status",
        "  tasks     List tasks with states and dependencies",
        "  agents    List active agents/roles and their sessions",
        "  pause     Pause a run safely",
        "  resume    Resume a paused run",
        "  cancel    Cancel a run (state preserved)",
        "  review    Produce an independent review of the current diff/plan",
        "  verify    Run verification gates and show PASS/FAIL/BLOCKED",
        "  doctor    Diagnose configuration, version, models, storage, git (FR-007)",
        "  approve   Approve a pending sensitive action",
        "  reject    Reject a pending sensitive action",
        "  report    Produce a final delivery report (FR-108)",
        "  help      Show this help",
    ].join("\n");
}
