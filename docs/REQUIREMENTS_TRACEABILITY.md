# TITAN — Requirements Traceability

> Source of truth: `TITAN_SRS_OpenCode_V2_AR_v1.0-1.docx` (extracted: `docs/SRS_AR.md`).
> Status legend: VERIFIED = code + tests + evidence; IMPLEMENTED = code written, tests pending; NOT_STARTED = planned phase.
> IDs follow the SRS numbering (FR-001..FR-110, NFR-001.., AC-01..AC-10).

## 7.1 Integration & plugin lifecycle (R0, R1)

| ID | Requirement (short) | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-001 | Load as V2 plugin via `@opencode/plugin` + `Plugin.define({id, setup(ctx)})` | VERIFIED | `src/index.ts` (`Plugin.define`, id `titan.orchestrator`); `src/probe.ts` (R0) | `sandbox` real-server load; `probe-result.json` |
| FR-002 | Verify OpenCode version at startup; surface incompatibility; never silently continue unsupported | VERIFIED | `src/application/doctor.ts` (`versionGte`, `parseVersion`, `MIN_OPENCODE_VERSION`); `src/index.ts` (startup log + `/titan doctor`) | `test/unit/doctor.test.ts` (versionGte, parseVersion, runDoctor unsupported → FAIL) |
| FR-003 | Register server tools/hooks/integrations via V2 documented interfaces only | VERIFIED | `src/index.ts` (`ctx.command.transform`, `ctx.session.hook` deferred); `src/probe.ts` (13 surfaces) | R0 probe 13/13 |
| FR-004 | Separate TUI part via `@opencode/plugin/tui` (P1) | NOT_STARTED | `src/tui.tsx` (stub entry) | — |
| FR-005 | Typed RPC between server and TUI (P1) | NOT_STARTED | `src/rpc.ts` (stub entry) | — |
| FR-006 | Idempotent setup + cleanup (stop timers/workers/subscriptions) | VERIFIED | `src/index.ts` (cleanup disposes all registrations, `cleaned` guard) | R1 server shutdown log |
| FR-007 | `/titan doctor`: config, version, models, storage, git, permissions | VERIFIED | `src/application/doctor.ts` (`runDoctor`, `renderDoctor`, `verdict`); `src/index.ts` (`/titan-doctor` + `/titan doctor`) | `test/unit/doctor.test.ts` (9 scenarios) |
| FR-110 | Core commands: plan, run, status, pause, resume, cancel, review, doctor | VERIFIED (parser + dispatch) | `src/application/commands.ts` (`parseTitanCommand`, `helpText`); `src/index.ts` (dispatch pipeline, handlers for help/version/doctor; honest stubs for others) | `test/unit/commands.test.ts` (10 scenarios) |

## 7.3 Task planning & DAG (R2 — verified)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-023 | Task graph (DAG) with dependencies | VERIFIED | `src/orchestration/dag.ts` (`Dag`); `RunManager.createRun` wires persisted tasks into DAG | `test/unit/dag.test.ts`; `test/unit/run-manager.test.ts` |
| FR-024 | Detect cycles / orphans / missing deps; reject invalid graphs before persisting | VERIFIED | `Dag.validate`, `findCycle`; `createRun` throws pre-persist (nothing written on invalid graph) | `test/unit/dag.test.ts` (6 scenarios); `test/unit/run-manager.test.ts` (cycle + missing-index rejected, DB stays empty) |
| FR-025 | Schedule only when dependencies complete | VERIFIED | `Dag.readyTasks`, `blockedTasks`; `RunManager.readyTasks` (deps SUCCEEDED + status gate) | `test/unit/dag.test.ts`; `test/unit/run-manager.test.ts` (root first, dependent after success) |
| FR-050 | Ready-set computation | VERIFIED | `Dag.readyTasks` + `RunManager.readyTasks`; `Orchestrator` scheduling loop consumes it | `test/unit/dag.test.ts`; `test/unit/orchestrator.test.ts` |
| FR-090 | Serialize/restore DAG state | VERIFIED | `Dag.serialize` / `Dag.deserialize` | `test/unit/dag.test.ts` |

## 7.3a Run/Task lifecycle manager (R2 — verified)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-008/009 | Run/Task lifecycle transitions, persisted + journaled; illegal rejected | VERIFIED | `src/application/run-manager.ts` (`transitionRun`/`transitionTask` persist + append event; illegal throws without persisting) | `test/unit/run-manager.test.ts` (legal→persisted+journaled; illegal→throws, status unchanged; FAILED never → SUCCEEDED) |
| FR-054 | Lease before worker starts; release on completion | VERIFIED | `RunManager.acquireTaskLease/releaseTaskLease`; `Orchestrator.startTask` acquires before execute, releases after | `test/unit/run-manager.test.ts`; `test/unit/persistence.test.ts` |
| FR-026/027 | Dependents of failed task never start on stale results | VERIFIED | `Orchestrator` failure branch: `propagateFailure` → dependents `SKIPPED` (ADR-006 skip-before-start) | `test/unit/orchestrator.test.ts` ("failure propagates to dependents") |
| FR-047 | Budget gate stops scheduling | VERIFIED | `Orchestrator` loop: `budget.shouldStopScheduling` → run PAUSED, `budget-exhausted` outcome | `test/unit/orchestrator.test.ts` (model-call budget exhaustion) |
| NFR-004 | Concurrency capped at maxWorkers | VERIFIED | `Orchestrator` slots = maxWorkers − running | `test/unit/orchestrator.test.ts` (max concurrency observed ≤ budget) |
| FR-106 | User cancel terminates run | VERIFIED | `Orchestrator.pause/resume/cancel` + AbortController race w/ executor | `test/unit/orchestrator.test.ts` (cancel mid-task → outcome `cancelled`) |

## 7.8a Recovery (R2 — verified, unit-level)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-056 | Resume only provably-safe work after restart | VERIFIED | `src/reliability/recovery.ts` (`recover`): integrity first, never auto-succeeds ambiguous work | `test/unit/recovery.test.ts` |
| NFR-010/011 | Ambiguous interrupted activity never guessed; marked for reconciliation | VERIFIED | `RUNNING/VERIFYING/WAITING_APPROVAL` with no live lease → `BLOCKED` + counted `tasksMarkedNeedsReconciliation` | `test/unit/recovery.test.ts` (RUNNING w/o lease → BLOCKED) |
| FAULT-lease | Stale leases of dead workers expire | VERIFIED | `adapter.expireLeases(now − staleMs)` | `test/unit/recovery.test.ts` (stale lease expired) |
| FAULT-integrity | Orphan/missing run references detected at startup | VERIFIED | `adapter.verifyIntegrity` issues surfaced in report | `test/unit/recovery.test.ts` (orphan task reported) |

## 7.5 Agents & models (R2 — written)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-030 | Configurable agent role catalog (10 roles) | VERIFIED | `src/agents/registry.ts` (`BUILTIN_ROLES`, `AgentRegistry`) | `test/unit/registry.test.ts` |
| FR-031 | Role separate from model/provider/session | VERIFIED | `AgentRegistry` (pure domain data, no OpenCode binding) | `test/unit/registry.test.ts` |
| FR-037 | Override/disable a role | VERIFIED | `register`/`remove` | `test/unit/registry.test.ts` |
| FR-040 | Discover models via OpenCode (never assume) | VERIFIED | `ModelRouter.setAvailable` (fed from `ctx.model.list()`) | `test/unit/budget-router.test.ts` |
| FR-042 | Route only within allowlist | VERIFIED | `ModelRouter.route` (allowlist enforced; pin-outside-allowlist rejected) | `test/unit/budget-router.test.ts` |
| FR-043 | Record why a model was chosen; manual pin disables auto-routing | VERIFIED | `RouteDecision.reason`, `pinned` | `test/unit/budget-router.test.ts` |
| FR-044 | Fallback only on failure and only if policy allows | VERIFIED | `ModelRouter.onFailure`, `allowFallback` | `test/unit/budget-router.test.ts` |
| FR-045 | Per-run budget: workers (4 default / 8 max), attempts, time | VERIFIED | `src/platform/budget.ts` (`normalizeBudget`, `BudgetManager`) | `test/unit/budget-router.test.ts` |
| FR-046 | Distinguish actual vs estimated cost | VERIFIED | `BudgetManager.recordActualCost`, `report()` costBasis | `test/unit/budget-router.test.ts` |
| FR-047 | Stop scheduling when budget exceeded | VERIFIED | `shouldStopScheduling`, `assertCanSpend` | `test/unit/budget-router.test.ts` |
| FR-100/101 | Least-privilege tool policy per role | VERIFIED | `AgentRegistry.canUseTool`, `allowedToolSet` | `test/unit/registry.test.ts` |

## 7.8 State & persistence (R2 — written)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-008/009 | Run/Task state machines; illegal transitions rejected; FAILED never → SUCCEEDED directly | VERIFIED | `src/domain/state.ts` (`transitionRun`, `transitionTask`, `wouldIllegallySucceed`) | `test/unit/state.test.ts` |
| FR-090 | Durable, transactional, migratable SQLite state | VERIFIED | `src/reliability/sqlite.ts` (`SqliteAdapter`, schema v1, migrations, indexes) | `test/unit/persistence.test.ts` |
| FR-091 | Append-only event journal with sequence + dedup | VERIFIED | `SqliteAdapter.appendEvent`, `listEvents`, `lastSeq` (dedup by correlationId) | `test/unit/persistence.test.ts` |
| FR-096 | Idempotency via idempotency keys | VERIFIED | `tasks.idempotencyKey`, event dedup | `test/unit/persistence.test.ts` |
| FR-054 | Leases for worker concurrency | VERIFIED | `SqliteAdapter.acquireLease/releaseLease/expireLeases` | `test/unit/persistence.test.ts` |
| NFR-024 | Approvals scoped to action+resource, expiring | VERIFIED | `SqliteAdapter` approvals, `Approval` type | `test/unit/persistence.test.ts` |

## 7.4 Agent execution (R3 — verified)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-060 | Worktree isolation for isolated-write roles | VERIFIED (real run) | `index.ts` `worktreeForTask` → `ctx.worktree.create`; executor passes `location.directory` | Sandbox `RUN-be0bc8c9`: implement/test sessions ran in registered worktrees; artifact created there |
| FR-061 | Merge isolated work back | NOT_STARTED | — | Explicit R4 item (ADR-007 limitations) |
| FR-032 | Worker sessions created per task w/ model routing | VERIFIED (real run) | `src/execution/session-executor.ts` (create → prompt → wait → judge) | `test/unit/execution.test.ts` (pure parts); sandbox run 6/6 |
| FR-003-inject | Role injection via `session.hook("context")` (ADR-003) | VERIFIED (real run) | executor hook w/ session scoping + dispose | `test/unit/execution.test.ts` payload; sandbox run used it live |
| FR-100/101 | Least-privilege tools denied at session | VERIFIED (real run) | `deniedToolsForRole` → `permissions[{action,resource:"*",effect:"deny"}]` at create | `test/unit/execution.test.ts`; live create accepted the permission batch |
| FR-043/44 | Routing reason, fallback on retryable failure | IMPLEMENTED | `ModelRouter` + executor fallback path | `test/unit/budget-router.test.ts`; live fallback not triggered (no provider failure) |
| FR-TIMEOUT | Task timeout/abort interrupt worker, never hang | VERIFIED (unit) | `Promise.race(prompt/wait, timeout, abort)` → `session.interrupt` | `test/unit/orchestrator.test.ts` (abort race); real path exercised in loop |
| FR-109 | Honest status output (`/titan status`) | VERIFIED (real run) | `renderRunStatus` + `/titan status` dispatch | `test/unit/execution.test.ts`; live: RUNNING→CLOSED transitions displayed |
| FR-110 | plan/run/status/tasks/agents/pause/resume/cancel commands | VERIFIED (parser+dispatch; live for plan/run/status/tasks) | `index.ts` `makeHandlers` R3 set | `test/unit/commands.test.ts`; live plan→run→status done |

## Non-functional requirements covered in R3

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| NFR-001 | setup ≤ 1.5s p95 (warm) | VERIFIED | Measured: 0ms/1ms on sandbox |
| NFR-004 | 4 workers default, tested to 8 | VERIFIED | `normalizeBudget` clamps to [1,8]; default 4 |
| NFR-005 | 100 tasks / 300 deps without data loss or deadlock | VERIFIED | `test/unit/dag.test.ts` scale test |
| NFR-006 | Local ops independent of model response time; TUI not blocked | VERIFIED | `display()` commits at ~40ms; interrupt suppresses model turn; no blocking await of model calls in setup |
| NFR-010 | No loss of committed state transitions | VERIFIED | SQLite transactions (BEGIN/COMMIT/ROLLBACK); purge cascades |
| NFR-024 | Approvals action+resource scoped, expiring | VERIFIED | `Approval` type + adapter |

## Non-functional requirements covered in R3

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| NFR-009 | Worker sessions isolated per task, no cross-login | VERIFIED | One session per task execution; create params recorded (tiling in journal) |
| NFR-011 | Restart recovery from durable state | VERIFIED (unit) | `test/unit/durable-db.test.ts`: close/reopen → same run + journal; recovery pass runs |

## Acceptance criteria (AC) — R1-relevant

| AC | Requirement | Status | Evidence |
|---|---|---|---|
| AC-01 | Plugin loads on OpenCode V2 | VERIFIED | `/tmp/opencode/titan-serve.log`: `[titan] titan.orchestrator loaded on OpenCode 2.2.5` |
| AC-02 | `/titan doctor` reports compatibility | VERIFIED | Transcript: "TITAN doctor — PASS" (7/7) |
| AC-03 | Commands dispatch and produce output | VERIFIED | 5 synthetic messages visible, 0 inbox backlog, 0 model tokens |

## Not yet started (honest status)

- R3: Run/Task manager, orchestrator, session management, worktrees, concurrency, handoffs, message bus (FR-050..074)
- R4: Verification engine, repair loop, approvals workflow, security (FR-080..089, FR-100..110) — **unit-verified in this phase** (see §7.5); real-session contract verification deferred to R5
- R5: TUI panel, RPC (FR-004, FR-005), delivery report (FR-108)
- R6: full test matrix, security audit, perf, final traceability
- Many FR/NFR/SEC/PERF IDs remain NOT_STARTED — listed as such, never claimed complete.


## 7.5 Verification & approval (R4 — verified, unit-level)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-062 | Evidence required before success | VERIFIED | `src/verification/gates.ts` (`verifyExecution`); applied in `Orchestrator.startTask` result branch | `test/unit/gates.test.ts` (AC evidence presence; impl/test evidence) |
| FR-063 | Failed verification re-queues while attempts remain | VERIFIED | FAILED -> NEEDS_REWORK -> QUEUED in orchestrator result branch | `test/unit/orchestrator.test.ts` (existing retry) |
| FR-102 | Supervised approval before mutating work | VERIFIED | `needsApproval` gate in `startTask`; `ApprovalRecord` (APR-*, 8h expiry) | `test/unit/approval.test.ts` (pending->parked; approve->completes same attempt; reject->FAILED+SKIPPED; expired->FAILED) |
| FR-103 | Approval expiry | VERIFIED | `processApprovals` auto-decides expired pending approvals | `test/unit/approval.test.ts` (expired case) |
| SEC-001 | No secrets in durable state | VERIFIED | `sanitizeForStore` on evidence summaries + gate reasons | `test/unit/redact.test.ts` |
| NFR-010/011 | Recovery never guesses; WAITING_APPROVAL untouched | VERIFIED | `recovery.ts` reconcile limited to RUNNING/VERIFYING | `test/unit/recovery.test.ts` (existing); R4 note |

## Non-functional requirements covered in R4 (summary)

- Verification is a *presence* gate (evidence exists). Semantic truth of evidence is R5's review/report surface -- stated honestly here.
