# ADR-008 — Verification gate + supervised approval workflow

**Status:** Accepted (R4), unit-tested
**Date:** 2026-11-09

## Context

R3 proved execution works end-to-end. R4 must ensure TITAN cannot claim a task
succeeded on the strength of the worker's self-report alone, and must support a
supervised mode where a human approves mutating work before it runs (SRS §9
verification, §10 security/permissions, FR-102).

## Decision

1. **Verification is a presence gate** (`src/verification/gates.ts`). A task
   reaches `SUCCEEDED` only when:
   - every acceptance criterion with `evidenceRequired` has at least one
     recorded evidence entry, AND
   - `implementation` and `test` task types produce at least one evidence entry.
   Failure routes `FAILED → NEEDS_REWORK → QUEUED` while attempts remain, so the
   rework loop engages (FR-062..FR-064). A `verify.result` journal entry is
   appended for every gate decision.
2. **Secret hygiene** (`src/security/redact.ts`). `sanitizeForStore` masks any
   credential-shaped substring in evidence summaries before persistence; the
   module is pure and unit-tested.
3. **Supervised approvals** (`run.mode === "supervised"`). Mutating task types
   (implementation, test, integration) are gated before execution:
   - first encounter creates an `ApprovalRecord` (id `APR-*`, 8h expiry) and
     parks the task in `WAITING_APPROVAL` (lease released, no model call made).
   - `Orchestrator.decideApproval` records `approved`/`rejected` (decidedBy,
     decidedAt) and journals `approval.decided`.
   - the main loop polls parked tasks each tick: approved → resume the same
     execution attempt (no attempts increment, `WAITING_APPROVAL → RUNNING`);
     rejected or expired → `FAILED` + dependents `SKIPPED`.
4. **Recovery respects the gate.** `recovery.ts` reconciles only
   `RUNNING/VERIFYING` to `BLOCKED`; `WAITING_APPROVAL` is deliberate parking
   and is never touched even without a live lease (FR-102).

## Command surface

- `/titan plan [--supervised|-s] <goal>` → `createRun({ mode: "supervised"|"direct" })`.
- `/titan approve [runId]` → approve all pending approvals in the run.
- `/titan reject [runId]` → reject all pending approvals in the run.

## Consequences

- A worker can no longer self-declare success: the orchestrator must see
  evidence before SUCCEEDED, and rework (or fail) otherwise.
- Supervised runs can never spend model calls on gated work without a human
  decision; the approval is recorded, expirable, and auditable.
- Verification here is a *presence* gate (evidence exists). Semantic truth of
  the evidence is R5's review/report surface — stated honestly in status docs.
- `needsApproval` only gates mutating task types; read-only roles proceed
  unattended even in supervised mode.
