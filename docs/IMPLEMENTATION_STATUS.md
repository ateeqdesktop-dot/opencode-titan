# TITAN — Implementation Status

> Living document. Updated as phases complete. `VERIFIED` requires evidence, not intent.

## Environment (verified)

| Item | Value | How verified |
|---|---|---|
| OpenCode CLI | v2.2.5 | `opencode --version` |
| `@opencode/plugin` (V2 SDK) | 2.2.6 | `bun install` + type inspection |
| `@opencode/client` | 2.2.6 | npm |
| Node | v26.13.0 | `node --version` |
| Bun | 1.3.14 | `bun --version` |
| Git | 2.53.0 | `git --version` |
| Available models | 142 (via `ctx.model.list()`), incl. free `opencode/*-free` | runtime probe |
| Real worker model used in tests | `opencode/iceman-free` | runtime probe |

## Critical compatibility findings (R0)

These were discovered by running a probe plugin inside a real OpenCode v2.2.5 server — **not** assumed from docs.

1. **Package name**: V2 SDK is `@opencode/plugin` (2.2.6). The old `@opencode-ai/plugin` (installed at `~/.opencode`, 1.15.7) is the **V1** package and must not be used.
2. **`command.list()` / `model.list()` return `{ location, data: Array }`** — the array is under `.data`, not top-level. (`ModelListOutput`, `CommandListOutput`.)
3. **`event.subscribe()` returns an `AsyncIterable`** — consume via `[Symbol.asyncIterator]()`/`for await`, **not** `.next()` directly. It is **live-only** (no replay): you must start listening *before* the event fires.
4. **`session.prompt` / `session.wait` MUST NOT be awaited synchronously inside `setup`.** Doing so **deadlocks the server** (exit=124 timeout). `setup` must return immediately; worker execution runs *after* setup completes. This is a hard architectural constraint (ADR-002).
5. **`ctx.agent.transform` has no `add`** — a plugin cannot register new agent definitions. Role instructions must be injected via `ctx.session.hook("context")` instead (ADR-003).
6. `ctx.shell.hook("create.before")` exists — TITAN can intercept/deny dangerous shell commands.
7. `ctx.permission.assert` + `ctx.session.update({permissions})` exist — approval gates are native.
8. `ctx.worktree.create/list/remove` exist (project-scoped).

## Phase status

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| R0 Discovery & compat | env, SDK types, plugin load, integration surfaces | **VERIFIED** | `src/probe.ts` → 13/13 setup surfaces + real worker `prompt/wait` = `WORKER_DONE` |
| R1 Foundation | project scaffold, types, config, errors, logging, storage, first command | **VERIFIED** | `src/index.ts` loads on OpenCode 2.2.5 (1ms setup); `/titan` + `/titan-doctor` dispatch (HTTP 204); `/titan doctor` → PASS (7/7 checks); 5 outputs visible, 0 model tokens, 0 inbox backlog; 103 unit tests pass; `tsc --noEmit` clean |
| R2 Core orchestration | DAG, state machine, persistence+SQLite, recovery, agent registry, budget, run/task lifecycle | **VERIFIED (unit-level)** | 132 tests pass / 0 fail (`bun test test/`); `tsc --noEmit` clean; new: `RunManager` (createRun w/ pre-persist DAG validation, transitions+journal, readiness, leases, role assignment, progress), `recovery.ts` (integrity, lease expiry, ambiguous RUNNING→BLOCKED, resume-only-safe), `Orchestrator` (scheduling loop, concurrency cap, budget gate, cancel, failure propagation → SKIPPED, retry via NEEDS_REWORK). Real-session contract deferred to R3 (needs actual executor binding per ADR-002) |
| R3 Agent execution | orchestrator↔session bind, role injection, worktrees, concurrency, handoffs | **VERIFIED (sandbox contract)** | Real run `RUN-be0bc8c9` on OpenCode 2.2.5: 6-task chain (explore→plan→implement→test→review→integrate) executed end-to-end, 6/6 SUCCEEDED with `opencode/iceman-free`; isolated-write roles ran in registered git worktrees (artifact produced there); least-privilege deny list at session create; ADR-003 role injection via `session.hook(context)`; journal shows full lifecycle (8 run transitions / 30 task transitions) in durable `.titan/titan.db`; `/titan doctor` PASS 7/7 in-process. Merge-back policy intentionally deferred to R4 (see ADR-007 limitations). 149 unit tests pass; `tsc --noEmit` clean |
| R4 Verification & reliability | verification engine, repair loop, approvals, security, recovery | NOT_STARTED | — |
| R5 UX & delivery | commands, status UI, RPC/TUI, docs, packaging | NOT_STARTED | — |
| R6 Hardening | full test matrix, security audit, perf, final traceability | NOT_STARTED | — |

## Known limitations

- Multi-agent live runs require configured model providers; free `opencode/*-free` models are available for tests, so worker execution is exercised for real (not mocked).
- Worktree isolation is proven against real git repos in sandbox; strategy selection per filesystem is validated in R3.
- The SRS source (`TITAN_SRS_OpenCode_V2_AR_v1.0-1.docx`) is the requirements truth; `docs/REQUIREMENTS_TRACEABILITY.md` maps FR/NFR IDs to implementation + tests.
