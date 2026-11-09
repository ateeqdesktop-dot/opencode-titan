/**
 * Verification gates (SRS §9 verification, FR-062..FR-064).
 *
 * A task never reaches SUCCEEDED just because its executor returned ok:true.
 * Every execution is gated on evidence the run can check mechanically:
 *   - every acceptance criterion marked `evidenceRequired` must have evidence;
 *   - `test`-type tasks must produce at least one evidence entry;
 *   - implementation-type tasks must produce at least one evidence entry.
 *
 * These are PRESENCE gates: they verify that the worker recorded proof. They do
 * not yet judge the semantic truth of the evidence (that is R5's review/report
 * surface) — verified honestly here and in `docs/IMPLEMENTATION_STATUS.md`.
 */
import type { Task } from "../domain/types.js"
import { type TaskExecutionResult } from "../orchestration/orchestrator.js"

export interface Verdict {
  readonly ok: boolean
  readonly issues: readonly string[]
}

export function verifyExecution(task: Task, result: TaskExecutionResult): Verdict {
  const issues: string[] = []
  const evidenceRequired = task.acceptanceCriteria.filter((a) => a.evidenceRequired)

  if (evidenceRequired.length > 0 && result.evidence.length === 0) {
    issues.push(
      `no evidence recorded for ${evidenceRequired.length} acceptance criteria (${evidenceRequired
        .map((a) => a.id)
        .join(", ")})`,
    )
  }
  if (task.type === "test" && result.evidence.length === 0) {
    issues.push("test task produced no test evidence")
  }
  if (task.type === "implementation" && result.evidence.length === 0) {
    issues.push("implementation task produced no change evidence")
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, issues: [] }
}

/** Which tasks need a human approval before execution (R4 rule, FR-102). */
export function needsApproval(task: Task): boolean {
  // Supervised runs gate every mutating worker role. Read-only roles proceed.
  return task.type === "implementation" || task.type === "integration" || task.type === "test"
}
