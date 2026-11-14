/** Built-in roles from SRS §5.3 (a practical subset; catalog is extensible). */
export const BUILTIN_ROLES = [
    {
        id: "orchestrator",
        name: "Lead / Orchestrator",
        description: "Routes the request, owns the plan, tasks, and result collection.",
        objective: "Coordinate the run to completion without doing the specialist work itself.",
        skills: ["planning", "decomposition", "coordination"],
        suitableTaskTypes: ["planning", "integration"],
        requiredInputs: ["goal", "constraints"],
        expectedOutputs: ["plan", "task-assignments"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob"],
        deniedTools: ["write", "edit", "bash"],
        access: "admin",
        riskLevel: "medium",
        limits: { maxAttempts: 3, timeoutSeconds: 1800 },
        workspacePolicy: "shared-read",
    },
    {
        id: "requirements-analyst",
        name: "Requirements Analyst",
        description: "Extracts requirements, assumptions, and acceptance criteria.",
        objective: "Produce a precise, testable requirement set with ambiguities flagged.",
        skills: ["requirements", "ambiguity-detection"],
        suitableTaskTypes: ["requirements"],
        requiredInputs: ["goal"],
        expectedOutputs: ["requirements", "acceptance-criteria", "open-questions"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob"],
        deniedTools: ["write", "edit", "bash"],
        access: "read-only",
        riskLevel: "low",
        limits: { maxAttempts: 2, timeoutSeconds: 900 },
        workspacePolicy: "shared-read",
    },
    {
        id: "explorer",
        name: "Repository Explorer",
        description: "Explores the project and surfaces relevant files/evidence.",
        objective: "Locate the relevant code, config, and tests for a scoped question.",
        skills: ["code-navigation", "summarization"],
        suitableTaskTypes: ["exploration"],
        requiredInputs: ["scope"],
        expectedOutputs: ["relevant-files", "findings"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob"],
        deniedTools: ["write", "edit", "bash"],
        access: "read-only",
        riskLevel: "low",
        limits: { maxAttempts: 2, timeoutSeconds: 600 },
        workspacePolicy: "shared-read",
    },
    {
        id: "architect",
        name: "Architect / Planner",
        description: "Designs the solution, dependencies, and decisions.",
        objective: "Produce an implementable design with explicit trade-offs.",
        skills: ["system-design", "trade-off-analysis"],
        suitableTaskTypes: ["planning"],
        requiredInputs: ["requirements", "repo-findings"],
        expectedOutputs: ["design", "task-graph"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob"],
        deniedTools: ["write", "edit", "bash"],
        access: "read-only",
        riskLevel: "medium",
        limits: { maxAttempts: 3, timeoutSeconds: 1800 },
        workspacePolicy: "shared-read",
    },
    {
        id: "implementer",
        name: "Implementer",
        description: "Writes code for an assigned, scoped task.",
        objective: "Deliver the change within the assigned file scope with passing checks.",
        skills: ["coding", "testing"],
        suitableTaskTypes: ["implementation", "repair"],
        requiredInputs: ["task-spec", "file-scope"],
        expectedOutputs: ["diff", "test-results"],
        preferredModel: undefined,
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob", "write", "edit", "bash"],
        deniedTools: [],
        access: "read-write",
        riskLevel: "medium",
        limits: { maxAttempts: 3, timeoutSeconds: 1800 },
        workspacePolicy: "isolated-write",
    },
    {
        id: "reviewer",
        name: "Reviewer",
        description: "Independent review of a plan or diff (never the author).",
        objective: "Produce severity-ranked, evidence-backed findings.",
        skills: ["code-review", "critical-analysis"],
        suitableTaskTypes: ["review"],
        requiredInputs: ["diff", "requirements"],
        expectedOutputs: ["findings"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob"],
        deniedTools: ["write", "edit", "bash"],
        access: "read-only",
        riskLevel: "low",
        limits: { maxAttempts: 2, timeoutSeconds: 1200 },
        workspacePolicy: "shared-read",
    },
    {
        id: "test-engineer",
        name: "Test / QA",
        description: "Selects and runs tests, analyzes results.",
        objective: "Produce reliable pass/fail evidence for a change.",
        skills: ["test-authoring", "failure-analysis"],
        suitableTaskTypes: ["test", "repair"],
        requiredInputs: ["change-scope"],
        expectedOutputs: ["test-results"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob", "bash"],
        deniedTools: ["write", "edit"],
        access: "read-write",
        riskLevel: "low",
        limits: { maxAttempts: 3, timeoutSeconds: 1200 },
        workspacePolicy: "isolated-write",
    },
    {
        id: "security-auditor",
        name: "Security Auditor",
        description: "Reviews for security risks and policy violations.",
        objective: "Flag concrete, reproducible security issues with evidence.",
        skills: ["security-review", "threat-modeling"],
        suitableTaskTypes: ["security"],
        requiredInputs: ["diff", "policy"],
        expectedOutputs: ["security-findings"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob"],
        deniedTools: ["write", "edit", "bash"],
        access: "read-only",
        riskLevel: "low",
        limits: { maxAttempts: 2, timeoutSeconds: 1200 },
        workspacePolicy: "shared-read",
    },
    {
        id: "debugger",
        name: "Debugger",
        description: "Diagnoses a failure cause and proposes a fix.",
        objective: "Identify root cause from evidence before editing.",
        skills: ["debugging", "root-cause-analysis"],
        suitableTaskTypes: ["repair"],
        requiredInputs: ["failure-evidence"],
        expectedOutputs: ["root-cause", "fix-proposal"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob", "bash"],
        deniedTools: [],
        access: "read-write",
        riskLevel: "medium",
        limits: { maxAttempts: 3, timeoutSeconds: 1200 },
        workspacePolicy: "isolated-write",
    },
    {
        id: "integrator",
        name: "Integrator / Release",
        description: "Merges locally and prepares the delivery summary.",
        objective: "Integrate verified changes and report, never push/publish unapproved.",
        skills: ["git-merge", "summarization"],
        suitableTaskTypes: ["integration", "documentation"],
        requiredInputs: ["verified-changes"],
        expectedOutputs: ["merge-result", "delivery-summary"],
        fallbackModels: [],
        allowedTools: ["read", "grep", "glob", "bash"],
        deniedTools: [],
        access: "read-write",
        riskLevel: "high", // merge is high-impact → approval gates apply
        limits: { maxAttempts: 2, timeoutSeconds: 1200 },
        workspacePolicy: "isolated-write",
    },
];
export class RoleNotFoundError extends Error {
    roleId;
    constructor(roleId) {
        super(`Unknown agent role: ${roleId}`);
        this.roleId = roleId;
        this.name = "RoleNotFoundError";
    }
}
export class AgentRegistry {
    roles = new Map();
    constructor(initial = BUILTIN_ROLES) {
        for (const r of initial)
            this.register(r);
    }
    /** Register (or replace) a role. FR-037 allows disabling/overriding a role. */
    register(role) {
        this.roles.set(role.id, role);
    }
    get(id) {
        const r = this.roles.get(id);
        if (!r)
            throw new RoleNotFoundError(id);
        return r;
    }
    has(id) {
        return this.roles.has(id);
    }
    remove(id) {
        return this.roles.delete(id);
    }
    list() {
        return [...this.roles.values()];
    }
    /** Roles suitable for a given task type (FR-030 suitableTaskTypes). */
    forTaskType(type) {
        return this.list().filter((r) => r.suitableTaskTypes.includes(type));
    }
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
    selectFor(type, preferredRoleId) {
        if (preferredRoleId) {
            const r = this.get(preferredRoleId);
            if (!r.suitableTaskTypes.includes(type)) {
                throw new Error(`Role ${preferredRoleId} is not suitable for task type ${type}`);
            }
            return r;
        }
        const candidates = this.forTaskType(type);
        if (candidates.length === 0)
            throw new Error(`No role registered for task type ${type}`);
        const riskOrder = { low: 0, medium: 1, high: 2 };
        const specialists = candidates.filter((r) => r.id !== "orchestrator");
        const pool = specialists.length > 0 ? specialists : candidates;
        return [...pool].sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel])[0];
    }
    /**
     * Whether a role is allowed to use a tool (FR-100/FR-101 least privilege).
     * Denied list wins over allowed list.
     */
    canUseTool(roleId, tool) {
        const r = this.get(roleId);
        if (r.deniedTools.includes(tool))
            return false;
        if (r.allowedTools.length === 0)
            return false;
        return r.allowedTools.includes(tool);
    }
    /** Tools a role may use, for building the `context` hook restriction (ADR-003). */
    allowedToolSet(roleId) {
        return new Set(this.get(roleId).allowedTools);
    }
    /** Validate a role has the fields FR-030 requires. */
    static validate(role) {
        const issues = [];
        const req = [
            "id",
            "name",
            "description",
            "objective",
            "skills",
            "suitableTaskTypes",
            "requiredInputs",
            "expectedOutputs",
            "fallbackModels",
            "allowedTools",
            "deniedTools",
            "access",
            "riskLevel",
            "limits",
            "workspacePolicy",
        ];
        for (const k of req) {
            if (role[k] === undefined)
                issues.push(`missing field: ${String(k)}`);
        }
        if (role.limits && (role.limits.maxAttempts < 1 || role.limits.timeoutSeconds < 1)) {
            issues.push("limits must be positive");
        }
        return issues;
    }
}
