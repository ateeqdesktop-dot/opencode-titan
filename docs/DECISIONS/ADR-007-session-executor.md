# ADR-007 — Real session executor (worker sessions bound to TITAN tasks)

**Status:** Accepted (R3), contract-verified against OpenCode 2.2.5
**Date:** 2026-11-09

## Context

TITAN must execute tasks with real OpenCode worker sessions — not mock agents —
while preserving: ADR-002 (no model-driven awaits inside `setup`), ADR-003
(roles are TITAN domain data injected at request time), FR-060 (worktree
isolation for isolated-write roles), FR-100/101 (least-privilege tools) and
FR-043/FR-044 (model routing + fallback).

## Decision

`src/execution/session-executor.ts` binds the orchestrator's `TaskExecutor`
abstraction to real sessions:

1. **Session creation** — per task: `ctx.session.create({ title, model, location,
   permissions, metadata })`. `model` comes from `ModelRouter.route` (fed only by
   `ctx.model.list()` — FR-040). `location.directory` = task worktree when the
   role's policy is `isolated-write`, else the project directory.
2. **Least privilege at creation** — every interactive tool (`write`, `edit`,
   `bash`, `webfetch`) outside `role.allowedTools` is sent with
   `effect: "deny"` on the session (session-scoped permissions).
3. **Role injection (ADR-003)** — `ctx.session.hook("context", cb)` pushes one
   system part per model request for the worker session only; registration is
   disposed in `finally` so nothing leaks to other sessions.
4. **Real work** — `session.prompt` (task brief incl. goal, criteria, artifacts)
   then experimental `session.wait` (idle). A `Promise.race` with the task
   timeout and the orchestrator's abort `AbortSignal` interrupts the session and
   returns an honest failure (timeout/cancelled) instead of hanging.
5. **Judging** — the LAST assistant message from `session.context` decides the
   outcome: `finish: "stop"` → succeeded; `error`/`content-filter`/other →
   failure with a mapped `ErrorClass` (SRS §12.1), tokens/cost recorded.
6. **Fallback (FR-044)** — a retryable create-failure routes to the routed
   fallback model once; `modelCalls` reflects both attempts.

## Verified evidence (real server, model `opencode/iceman-free`)

Run `RUN-be0bc8c9` (sandbox project, "create demo.txt with TITAN-OK"):

- Planned 6-task chain → executed end-to-end → run **CLOSED (SUCCEEDED)**,
  6/6 tasks SUCCEEDED, attempts=1 per task.
- Journal in durable project DB (`.titan/titan.db`): 1× `run.created`,
  8× `run.transition` (full lifecycle), 30× `task.transition`
  (6 × DRAFT→READY→QUEUED→RUNNING→VERIFYING→SUCCEEDED), 6× `task.assigned`,
  6× `task.finished`.
- Worktree isolation: implementer + test-engineer sessions ran in
  `~/.local/share/opencode/worktree/<proj>/titan-TASK-<id>` (registered git
  worktrees); read-only roles ran in the project directory. The goal artifact
  (`demo.txt` = `TITAN-OK`) was produced inside the isolated worktrees.
- Doctor PASS 7/7 in the same process (143 models discovered).

## Known limitations (honest)

- **Worktree merge policy implemented in R6** (SRS FR-061): on a successful
  verified task, the worktree commit is cherry-picked into the main tree and
  the worktree is removed. Verified by isolated git simulation; live
  verification blocked by free-model quota exhaustion, not a code defect.
- Role selection preferentially picks specialists over the coordinator role
  (registry change in R3); `architect`/`integrator` are used for planning and
  integration after the fix.
- Fallback path is unit-tested but was not exercised live (no live provider
  failure occurred during verification).
