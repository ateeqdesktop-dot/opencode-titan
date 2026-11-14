export function verifyExecution(task, result) {
    const issues = [];
    const evidenceRequired = task.acceptanceCriteria.filter((a) => a.evidenceRequired);
    if (evidenceRequired.length > 0 && result.evidence.length === 0) {
        issues.push(`no evidence recorded for ${evidenceRequired.length} acceptance criteria (${evidenceRequired
            .map((a) => a.id)
            .join(", ")})`);
    }
    if (task.type === "test" && result.evidence.length === 0) {
        issues.push("test task produced no test evidence");
    }
    if (task.type === "implementation" && result.evidence.length === 0) {
        issues.push("implementation task produced no change evidence");
    }
    if (issues.length > 0)
        return { ok: false, issues };
    return { ok: true, issues: [] };
}
/** Which tasks need a human approval before execution (R4 rule, FR-102). */
export function needsApproval(task) {
    // Supervised runs gate every mutating worker role. Read-only roles proceed.
    return task.type === "implementation" || task.type === "integration" || task.type === "test";
}
