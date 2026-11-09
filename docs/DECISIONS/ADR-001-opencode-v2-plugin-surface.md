# ADR-001: OpenCode V2 plugin surface is the integration contract

## Status
Accepted (R0, verified against installed `@opencode/plugin@2.2.6` types + runtime probe)

## Context
TITAN must be a native OpenCode V2 plugin, not a renamed V1 plugin. The brief and SRS both forbid building on V1 APIs or on memory/assumption. We must know the *actual* surface before writing any integration.

## Decision
Use `@opencode/plugin` **2.2.6** (the V2 SDK) exclusively. Define plugins via `Plugin.define({ id, setup(ctx) })`. Build every integration against the installed type declarations (`node_modules/@opencode/plugin/dist/**/*.d.ts`), not from documentation prose or memory.

The package name differs from V1: V2 = `@opencode/plugin`, V1 = `@opencode-ai/plugin`. The latter is present at `~/.opencode` (1.15.7) and is a stale V1 artifact — do not depend on it.

## Consequences
- A compatibility probe (`src/probe.ts`) runs inside a real OpenCode v2.2.5 server and asserts each surface TITAN needs. It is the gate for building on any integration.
- Any future API drift is caught by re-running the probe + contract tests rather than discovered in production.

## Verified surfaces (R0, 13/13)
`plugin.define`, `location`, `storage`, `session.create/get/remove`, `tool.transform/add/list`, `command.transform/add/list`, `event.subscribe`, `worktree.list`, `model.list`, `vcs.status`, `permission.assert`, `session.hook(context)`, plus a **real** `session.prompt/wait` worker cycle returning `WORKER_DONE`.
