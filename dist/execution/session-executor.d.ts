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
import type { TaskExecutor } from "../orchestration/orchestrator.js";
import type { AgentRole, ErrorClass, Task } from "../domain/types.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { PluginCtx } from "../platform/opencode.js";
/**
 * Which interactive tools must be denied for this role's session, per the
 * least-privilege rule (FR-100/101): every interactive tool outside
 * `role.allowedTools` is denied with a session-scoped permission.
 */
export declare function deniedToolsForRole(role: AgentRole): readonly string[];
/**
 * Build the ADR-003 role-injection system part: who the worker is, what it may
 * touch, and how it must behave. Deterministic text derived from registry data.
 */
export declare function roleSystemText(role: AgentRole, goal: string): string;
/** The user prompt that carries the task into the worker session. */
export declare function taskPromptText(task: Task, goal: string): string;
/** Classify an unexpected error for the retry engine (SRS §12.1). */
export declare function classifySessionError(e: unknown): ErrorClass;
export interface AssistantExtract {
    readonly found: boolean;
    readonly finish?: string;
    readonly text: string;
    readonly outputTokens?: number;
    readonly costUsd?: number;
    readonly errorMessage?: string;
}
/** Pull the LAST assistant message out of a `session.context` payload. */
export declare function extractAssistant(payload: unknown): AssistantExtract;
/** One-line outcome: prefer the explicit `TITAN_RESULT:` line, else the last text line. */
export declare function summarizeOutcome(text: string): string;
export interface SessionExecutorOptions {
    readonly ctx: PluginCtx;
    /** Resolves the role id to its full definition (ADR-003 injection payload). */
    readonly registry: AgentRegistry;
    /** Fallback single-task cap (ms) when TaskLimits.timeoutSeconds is unset/0. */
    readonly defaultTimeoutMs?: number;
}
export declare function createSessionExecutor(o: SessionExecutorOptions): TaskExecutor;
