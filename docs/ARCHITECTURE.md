# TITAN — Architecture

> Version 0.1.0 · OpenCode V2 Plugin · 2026-11-14

## Overview

TITAN is a multi-agent engineering orchestration plugin for OpenCode V2. It transforms
a single AI coding session into a coordinated team of specialist agents that plan,
implement, test, review, and integrate software changes autonomously.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        OpenCode V2 Server                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    TITAN Plugin (src/index.ts)              │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │  │
│  │  │ Commands │ │ Display  │ │  Engine   │ │   Cleanup    │  │  │
│  │  │ (FR-110)│ │(FR-107)  │ │ (core)    │ │  (FR-006)    │  │  │
│  │  └────┬────┘ └────┬─────┘ └─────┬─────┘ └──────┬───────┘  │  │
│  │       │           │             │              │           │  │
│  │  ┌────┴───────────┴─────────────┴──────────────┴───────┐  │  │
│  │  │              Orchestrator (src/orchestration/)        │  │  │
│  │  │  ┌───────┐ ┌────────┐ ┌───────┐ ┌──────────────┐   │  │  │
│  │  │  │  DAG  │ │ State  │ │Budget │ │   Recovery   │   │  │  │
│  │  │  │       │ │Machine │ │Manager│ │              │   │  │  │
│  │  │  └───────┘ └────────┘ └───────┘ └──────────────┘   │  │  │
│  │  └──────────────────────┬──────────────────────────────┘  │  │
│  │                         │                                 │  │
│  │  ┌──────────────────────┴──────────────────────────────┐  │  │
│  │  │           Session Executor (src/execution/)          │  │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────────┐  │  │  │
│  │  │  │ Session    │ │ Role       │ │ Least-Privilege│  │  │  │
│  │  │  │ Create     │ │ Injection  │ │ Permissions    │  │  │  │
│  │  │  └────────────┘ └────────────┘ └────────────────┘  │  │  │
│  │  └──────────────────────┬──────────────────────────────┘  │  │
│  │                         │                                 │  │
│  │  ┌──────────────────────┴──────────────────────────────┐  │  │
│  │  │              Run Manager (src/application/)          │  │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │  │  │
│  │  │  │CreateRun │ │Transition│ │ Readiness/Leases │   │  │  │
│  │  │  └──────────┘ └──────────┘ └────────────────────┘   │  │  │
│  │  └──────────────────────┬──────────────────────────────┘  │  │
│  │                         │                                 │  │
│  │  ┌──────────────────────┴──────────────────────────────┐  │  │
│  │  │        Persistence (src/reliability/)               │  │  │
│  │  │  ┌──────────┐ ┌──────────┐ ┌────────────────────┐   │  │  │
│  │  │  │ SQLite   │ │ Adapter  │ │ Recovery           │   │  │  │
│  │  │  │ (durable)│ │          │ │                    │   │  │  │
│  │  │  └──────────┘ └──────────┘ └────────────────────┘   │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                 │
│  ┌───────────────────────────┴───────────────────────────────┐  │
│  │              OpenCode V2 APIs (used by TITAN)             │  │
│  │  session.create/get/prompt/wait/interrupt/synthetic/context│  │
│  │  session.hook("context")  worktree.create/remove           │  │
│  │  model.list  storage  permission  vcs  command.transform   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    TITAN TUI (src/tui.ts)                       │
│  Separate plugin part — registers /titan slash command + toast  │
│  Fetches status via RPC contract (src/rpc/contract.ts)          │
└─────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
src/
├── index.ts              # Plugin entry (server part)
├── tui.ts                # TUI plugin (separate part)
├── platform/
│   ├── opencode.ts       # PluginCtx type alias
│   └── budget.ts         # Budget manager
├── domain/
│   ├── types.ts          # All domain types, state machines, constants
│   └── state.ts          # Transition enforcement
├── agents/
│   ├── registry.ts       # Agent role catalog + selection
│   └── router.ts         # Model routing
├── application/
│   ├── run-manager.ts    # Run/Task lifecycle manager
│   ├── commands.ts       # Command parser + help
│   ├── doctor.ts         # Compatibility diagnostics
│   └── playbook.ts       # 6-step blueprint + status rendering
├── orchestration/
│   ├── orchestrator.ts   # Scheduling loop, approval gate, verification
│   └── dag.ts            # Directed acyclic graph
├── execution/
│   └── session-executor.ts  # Real worker sessions
├── verification/
│   └── gates.ts          # Evidence presence gates
├── security/
│   └── redact.ts         # Secret masking
├── reliability/
│   ├── adapter.ts        # PersistenceAdapter interface
│   ├── sqlite.ts         # SQLite driver (bun/node/memory)
│   └── recovery.ts       # Restart recovery
└── rpc/
    └── contract.ts       # Typed RPC contract
```

## Key Design Decisions

See `docs/DECISIONS/` for full ADRs:

| ADR | Title | Summary |
|---|---|---|
| ADR-001 | OpenCode V2 Plugin Surface | Build against installed types + probe evidence |
| ADR-002 | Setup Non-Blocking | No model-driven awaits in setup() |
| ADR-003 | Role Injection via Context Hook | Roles are TITAN domain data, injected at request time |
| ADR-004 | SQLite Persistence | File-backed, restart-safe, driver-agnostic |
| ADR-005 | Command Display | synthetic + poll + interrupt (0 model tokens) |
| ADR-006 | Dependency Index + Skip-Before-Start | `#N` refs; DRAFT/BLOCKED/READY→SKIPPED legal |
| ADR-007 | Real Session Executor | Per-task sessions with role injection, worktrees, fallback |
| ADR-008 | Verification + Approval Gates | Evidence presence, supervised approvals, 8h expiry |

## Data Flow

### Run Lifecycle
```
CREATED → PREFLIGHT → ANALYZING → PLANNING → READY → RUNNING → VERIFYING → SUCCEEDED → CLOSED
                                                          ↓
                                                      PAUSED (budget)
                                                          ↓
                                                      FAILED → CLOSED
```

### Task Lifecycle
```
DRAFT → READY → QUEUED → RUNNING → VERIFYING → SUCCEEDED
                                    ↓
                              WAITING_APPROVAL (supervised)
                                    ↓
                              FAILED → NEEDS_REWORK → QUEUED (retry)
                                    ↓
                              SKIPPED (upstream failed, never started)
```

### Execution Flow (per task)
1. `Orchestrator.startTask()` acquires lease, assigns role + model
2. If supervised mode + mutating type → creates approval, parks in WAITING_APPROVAL
3. `SessionExecutor` creates worker session (model, worktree, permissions)
4. Role injected via `session.hook("context")` (ADR-003)
5. `session.prompt(task brief)` → real work
6. `session.wait` (idle) raced against timeout/abort
7. Last assistant message judged (finish/cost/tokens)
8. Evidence sanitized (`sanitizeForStore`) before persistence
9. Verification gate: AC evidence + impl/test evidence required
10. On success: worktree merged back (cherry-pick), worktree removed
11. On failure: dependents SKIPPED, retry if attempts remain

## Persistence

- **Driver**: bun:sqlite (primary) → node:sqlite (fallback) → in-memory (tests)
- **File**: `<project>/.titan/titan.db` (durable, survives restarts)
- **Schema**: runs, tasks, events (append-only journal), leases, approvals, budgets
- **Integrity**: verified on startup; orphans reported

## Security

- Secret redaction before persistence (`sanitizeForStore`)
- Least-privilege tool denial at session creation (FR-100/101)
- Session-scoped permissions (deny list per role)
- Isolated worktrees for write-heavy roles (FR-060)
- Approval expiry (8h default, FR-102)
- Recovery never auto-succeeds ambiguous work (NFR-010/011)

## Testing

- 166 unit tests across 16 files
- `bun test test/` — all pass
- `bunx tsc --noEmit` — clean (strict mode)
- Live sandbox verification against OpenCode 2.2.5 (see docs/READINESS.md)
