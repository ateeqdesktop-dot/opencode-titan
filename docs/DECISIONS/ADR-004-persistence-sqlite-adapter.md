# ADR-004: Persistence = SQLite behind an adapter, with `ctx.storage` fallback

## Status
Accepted (R2 design; adapter interface fixed in R1)

## Context
SRS requires durable, transactional, migratable state (Runs, Tasks, DAG, events, approvals, budgets) that survives OpenCode restarts. The brief specifies SQLite as the initial design, *provided* the runtime supports it, behind a persistence adapter so logic is not coupled to one library.

## Decision
- Define a `PersistenceAdapter` interface (typed repositories for Runs, Tasks, Dependencies, Events, Approvals, Budgets, Artifacts, Sessions, Workspaces, VerificationResults).
- Primary driver: SQLite. The plugin runs inside the OpenCode server process (Bun). Probe which driver is available at runtime (`bun:sqlite` under Bun, `node:sqlite` under Node) and select it; the adapter hides the choice from domain logic.
- Fallback: if neither SQLite driver is available, degrade to a JSON-file/`ctx.storage`-backed adapter with a documented limitation (no cross-row transactions), so the system still functions.
- Schema versioning + migrations are mandatory; state changes are transactional; an append-only event log is kept alongside current state.

## Consequences
- Domain/orchestration code depends only on `PersistenceAdapter`.
- Recovery reads persisted state, validates integrity, reconciles ambiguous activities (`NEEDS_RECONCILIATION`), and resumes only provably-safe work.
- `ctx.storage` (OpenCode's durable JSON KV) is used for small plugin-scoped values (probe results, config cache), **not** as the primary run/task store.
