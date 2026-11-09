# ADR-002: `setup` must be non-blocking; worker execution runs after it

## Status
Accepted (R0, discovered empirically — awaiting a model call inside `setup` deadlocked the server)

## Context
Agent execution (Module 5) needs `session.create → switchModel → prompt → wait → read result`. The natural (but wrong) place to drive this is inside the plugin's `setup`, which runs during plugin load.

## Decision
`setup(ctx)` must **return immediately** after registering hooks/commands/tools/storage. It must never `await` a model-driven operation (`session.prompt`, `session.wait`, `session.generate`). Worker/agent execution is triggered **after** setup completes — by commands, events, or a background task started with fire-and-forget (`void worker()`), whose results are surfaced via persistence/RPC, not by blocking setup.

## Consequences
- The orchestrator's run loop is event/command-driven, not setup-driven.
- Background tasks write results to storage; readers observe state, not blocking returns.
- The probe proves this: an awaited `prompt/wait` in `setup` → server hang (exit=124); a fire-and-forget background worker → completes with `WORKER_DONE`.

## Evidence
`src/probe.ts` — `workerTest()` is invoked with `void` (not awaited); external test reads `probe-worker.json`.
