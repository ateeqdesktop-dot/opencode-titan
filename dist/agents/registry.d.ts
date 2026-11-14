/**
 * Agent Registry (SRS §5.3, FR-030, FR-031).
 *
 * A configurable catalog of roles. The role is deliberately SEPARATE from any OpenCode
 * agent ID, model, provider, or session (FR-031) — a role is TITAN domain data that is
 * injected into a worker session at request time (ADR-003).
 *
 * Roles are selected dynamically per task; not every role runs for every task (SRS §5.4).
 */
import type { AgentRole, TaskType } from "../domain/types.js";
/** Built-in roles from SRS §5.3 (a practical subset; catalog is extensible). */
export declare const BUILTIN_ROLES: readonly AgentRole[];
export declare class RoleNotFoundError extends Error {
    readonly roleId: string;
    constructor(roleId: string);
}
export declare class AgentRegistry {
    private readonly roles;
    constructor(initial?: readonly AgentRole[]);
    /** Register (or replace) a role. FR-037 allows disabling/overriding a role. */
    register(role: AgentRole): void;
    get(id: string): AgentRole;
    has(id: string): boolean;
    remove(id: string): boolean;
    list(): AgentRole[];
    /** Roles suitable for a given task type (FR-030 suitableTaskTypes). */
    forTaskType(type: TaskType): AgentRole[];
    /**
     * Pick the best role for a task type. Preference order: explicitly requested
     * role → any specialist (non-orchestrator) suitable role, lowest risk first →
     * orchestrator → first registered.
     *
     * Rationale (SRS §5.3): the orchestrator role owns coordination; assigning it
     * to ordinary specialist tasks starves specialists and gives read-only or
     * write-heavy work to the wrong tool policy. Specialists win whenever one is
     * registered for the type.
     */
    selectFor(type: TaskType, preferredRoleId?: string): AgentRole;
    /**
     * Whether a role is allowed to use a tool (FR-100/FR-101 least privilege).
     * Denied list wins over allowed list.
     */
    canUseTool(roleId: string, tool: string): boolean;
    /** Tools a role may use, for building the `context` hook restriction (ADR-003). */
    allowedToolSet(roleId: string): ReadonlySet<string>;
    /** Validate a role has the fields FR-030 requires. */
    static validate(role: AgentRole): string[];
}
