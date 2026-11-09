# ADR-006 — Task dependency references & skip-before-start policy

**Status:** Accepted (R2)
**Date:** 2026-11-08

## Context

Tasks are declared in `createRun` as a list. Dependencies between them must be
expressible before the generated task IDs (`TASK-xxxxxxxx`) exist.

Separately, when a task fails, its not-yet-started dependents must be removed
from the schedulable set. The Task state machine (SRS §8.3) originally allowed
`DRAFT → {READY, BLOCKED, CANCELLED}` only, so the orchestrator's failure
propagation (`SKIPPED`) was silently swallowed for `DRAFT` dependents.

## Decision

1. **Index-based dependency references.** `CreateTaskInput.dependencies`
   entries may use `"#N"` (0-based index into the same input array) which is
   resolved to the generated task id at creation time, or a literal task id.
   Out-of-range indices abort run creation **before any persistence** (no
   partial runs).
2. **Skip-before-start is legal; skip-after-start is not.**
   `DRAFT/BLOCKED/READY → SKIPPED` is added to `TASK_TRANSITIONS`. A task that
   never started may be skipped (upstream failure or user decision). A task
   that already started (`RUNNING`, `VERIFYING`) or already failed (`FAILED`)
   may **not** be marked `SKIPPED` — that path must produce an honest failure.
   `RUNNING/FAILED → SKIPPED` remains illegal (covered by
   `test/unit/state.test.ts`).

## Consequences

- Failure propagation is observable end-to-end: failing task → `FAILED`,
  dependents → `SKIPPED`, run → `FAILED` (`test/unit/orchestrator.test.ts`).
- Skipping can never mask a failure of the skipped task itself; it only marks
  work that will never start.
- Index refs make run creation callers deterministic; documented contract for
  `/titan run` planning in R3.
