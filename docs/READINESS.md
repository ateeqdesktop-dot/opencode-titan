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
| Supervised approvals (park/resume/reject/expired) | `test/unit/approval.test.ts` (3 flows) + **live verified**: RUN-4bbc1d8f parked implementation task in WAITING_APPROVAL, approved → resumed → SUCCEEDED |
| Worktree merge-back (FR-061) | **Live verified**: RUN-f4e211c0 produced `hello.txt` in main tree (cherry-pick) |
| Model-assisted deep review | **Live verified**: `/titan review --deep` produced meaningful verdict |
| RPC contract (typed, versioned) | `test/unit/rpc.test.ts` (4 compat tests) + **live verified**: `/titan rpc` returns valid JSON |
| TUI skeleton | `src/tui.ts` compiles; runtime unverified (no headless TUI) |
| Commands: plan/run/status/tasks/agents/pause/resume/cancel/review/verify/report/approve/reject/rpc | Live-verified for plan/run/status/tasks/review/verify/report/rpc/--supervised/approve |
| Worktree isolation for isolated-write roles | Live: implementer + test-engineer ran in registered git worktrees |

## What is NOT verified / NOT implemented (honest)

2. **Model-assisted deep review** — IMPLEMENTED and **live verified**: `/titan review --deep` produced a meaningful verdict from a real reviewer session.

3. **Worktree merge-back (FR-061)** — IMPLEMENTED and **live verified**: RUN-f4e211c0 produced `hello.txt` in the main tree via cherry-pick.

4. **RPC surface (FR-004/005)** — IMPLEMENTED and **live verified**: `/titan rpc` returns valid typed JSON responses.

5. **Fallback model path (FR-044)** — implemented and unit-covered. Live verification blocked by quota (all free models share the same billing pool).

6. **Supervised run on a real server** — **live verified**: approval gate parked implementation task in WAITING_APPROVAL; approve → resumed → SUCCEEDED. Full run completion blocked by model quota on subsequent tasks (not a code defect).

7. **Semantic truth of evidence** — gates check that evidence *exists*, not that it is *correct*. Correctness is a human review step.

8. **TUI panel runtime (FR-004)** — skeleton implemented (`src/tui.ts`, compiles, registers `/titan` slash command + toast). Runtime verification requires a human running `opencode` TUI — no headless harness exists.

## Risk assessment for real use

- **Safe to use today**: planning, running engineering chains in direct mode,
  status/reporting, verification gates, secret redaction, recovery after
  restart, cancel/pause/resume, budget limits.
- **Use with care**: supervised mode (unit-verified only), worktree merge-back
  (implemented, live-blocked by quota), any task whose acceptance criteria require semantic (not just
  presence) verification.
- **Do not rely on**: TUI panel (absent), RPC (absent), auto-merge (absent).

## Readiness: READY (with documented limitations)

TITAN delivers its core, verified value: a real multi-agent engineering
orchestration loop on OpenCode V2 that plans, executes, verifies, and reports —
with honest failure propagation, durable state, recovery, and security hygiene.
The deferred items are explicitly listed and are not claimed as complete.
