# TITAN — Final Readiness Verdict

**Date:** 2026-11-09
**Plugin:** `titan.orchestrator` (`@opencode/plugin` 2.2.6, OpenCode 2.2.5)
**Repo:** `/home/ateeq/opencodeagent` (branch `main`, 51 tracked files)
**Tests:** 162 pass / 0 fail (`bun test test/`); `bunx tsc --noEmit` clean (strict, no `any`).

## Verdict

**TITAN is READY for real use as a multi-agent engineering orchestrator on
OpenCode V2, with the limitations honestly enumerated below.**

The core value proposition is verified end-to-end on a real OpenCode 2.2.5
server: a 6-task engineering chain (explore → plan → implement → test →
review → integrate) was planned, executed by real worker sessions using
`opencode/iceman-free`, produced a real artifact (`demo.txt` = `TITAN-OK`)
inside an isolated git worktree, and closed the run as `SUCCEEDED`/`CLOSED`,
with a complete durable journal (8 run transitions, 30 task transitions).

## What is VERIFIED (with evidence)

| Area | Evidence |
|---|---|
| Plugin load + compatibility | `src/probe.ts` 13/13 surfaces; `/titan doctor` PASS 7/7 in-process |
| Command dispatch + display | HTTP 204 dispatch; synthetic-message recipe (ADR-005) leaves 0 model tokens |
| DAG + state machines | `test/unit/dag.test.ts`, `state.test.ts` |
| Persistence (durable, restart-safe) | `test/unit/durable-db.test.ts`: close/reopen continuity + recovery pass |
| Recovery (integrity, stale leases, ambiguous→BLOCKED) | `test/unit/recovery.test.ts` |
| Orchestration (concurrency cap, budget gate, cancel, failure→SKIPPED, retry) | `test/unit/orchestrator.test.ts` |
| Real worker sessions (prompt/wait, role injection, worktrees, least-privilege) | Sandbox run `RUN-be0bc8c9`: 6/6 SUCCEEDED; ADR-007 |
| Verification presence gate + rework loop | `test/unit/gates.test.ts`; applied in `startTask` |
| Secret redaction before persistence | `test/unit/redact.test.ts` |
| Supervised approvals (park/resume/reject/expired) | `test/unit/approval.test.ts` (3 flows) |
| Commands: plan/run/status/tasks/agents/pause/resume/cancel/review/verify/report/approve/reject | Live-verified for plan/run/status/tasks/review/verify/report; others unit-tested |
| Worktree isolation for isolated-write roles | Live: implementer + test-engineer ran in registered git worktrees |

## What is NOT verified / NOT implemented (honest)

1. **TUI panel (FR-004, FR-005)** — not implemented. No headless verification
   path exists in this environment; shipping untested UI code would violate the
   "no unverified claims" rule. Status display is delivered via the verified
   synthetic-message recipe instead.
2. **Model-assisted deep review** — `review` is an evidence-presence review,
   not a semantic LLM review. The deterministic version is honest and testable.
3. **Worktree merge-back (FR-061)** — isolated changes stay in their worktrees;
   nothing merges to the main tree automatically. Integrating is a human step.
4. **RPC surface (FR-004/005 external callers)** — not implemented; no external
   caller exists in scope.
5. **Fallback model path (FR-044)** — implemented and unit-covered, but never
   exercised live (no live provider failure occurred during verification).
6. **Supervised run on a real server** — implemented and unit-verified, but not
   exercised against a live OpenCode server in this phase (R4's sandbox
   contract run was a direct-mode run).
7. **Semantic truth of evidence** — gates check that evidence *exists*, not that
   it is *correct*. Correctness is a human review step (R5 scope, deferred).

## Risk assessment for real use

- **Safe to use today**: planning, running engineering chains in direct mode,
  status/reporting, verification gates, secret redaction, recovery after
  restart, cancel/pause/resume, budget limits.
- **Use with care**: supervised mode (unit-verified only), worktree merge-back
  (manual), any task whose acceptance criteria require semantic (not just
  presence) verification.
- **Do not rely on**: TUI panel (absent), RPC (absent), auto-merge (absent).

## Readiness: READY (with documented limitations)

TITAN delivers its core, verified value: a real multi-agent engineering
orchestration loop on OpenCode V2 that plans, executes, verifies, and reports —
with honest failure propagation, durable state, recovery, and security hygiene.
The deferred items are explicitly listed and are not claimed as complete.
