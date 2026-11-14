# TITAN — Developer Guide

> For contributors and developers extending TITAN.

## Prerequisites

- Node.js v26+ or Bun 1.3+
- OpenCode V2 (2.2.5+) installed
- Git 2.50+
- TypeScript 5.9+

## Setup

```sh
git clone <repo>
cd opencodeagent
bun install
bun run typecheck   # tsc --noEmit
bun test test       # 166 tests
```

## Project Structure

```
src/
├── index.ts              # Plugin entry (server part)
├── tui.ts                # TUI plugin (separate part)
├── platform/             # Platform abstractions
├── domain/               # Types, state machines
├── agents/               # Role registry, model router
├── application/          # Run manager, commands, doctor, playbook
├── orchestration/        # Orchestrator, DAG
├── execution/            # Session executor
├── verification/         # Gates
├── security/             # Redaction
├── reliability/          # Persistence, recovery
└── rpc/                  # RPC contract

test/unit/               # 16 test files, 166 tests
docs/                    # Documentation
sandbox/                 # OpenCode server test harness
```

## Key Patterns

### Adding a New Command

1. Add to `TITAN_SUBCOMMANDS` in `src/application/commands.ts`
2. Add handler in `makeHandlers()` in `src/index.ts`
3. Add help text in `helpText()` in `commands.ts`
4. Update traceability in `docs/REQUIREMENTS_TRACEABILITY.md`

### Adding a New Agent Role

1. Add to `BUILTIN_ROLES` in `src/agents/registry.ts`
2. Set `suitableTaskTypes`, `allowedTools`, `workspacePolicy`, `riskLevel`
3. Role is auto-discovered by `selectFor(taskType)`

### Adding a Verification Gate

1. Add rule to `verifyExecution()` in `src/verification/gates.ts`
2. Add test in `test/unit/gates.test.ts`
3. Update traceability

### Adding an RPC Endpoint

1. Add request/response types to `src/rpc/contract.ts`
2. Add case to `rpc()` in `src/index.ts`
3. Add validation in `validateRequest()`
4. Add test in `test/unit/rpc.test.ts`

## Testing

```sh
# Run all tests
bun test test

# Run specific file
bun test test/unit/orchestrator.test.ts

# Type check
bunx tsc --noEmit

# Live sandbox test
cd sandbox && opencode serve --port 4999 --print-logs
# Then use curl to dispatch commands
```

## Sandbox Testing

The `sandbox/` directory contains an OpenCode server configuration that loads
the plugin from `../`. Use it for live verification:

```sh
cd sandbox
opencode serve --port 4999 --print-logs
# Server password is printed in the log
# Use curl with Basic auth to dispatch commands
```

## Code Style

- TypeScript strict mode, no `any`
- ESLint: expo + prettier config
- All domain errors are typed (`ErrorClass`)
- State transitions are enforced (illegal = throw)
- Evidence is sanitized before persistence

## Architecture Decisions

See `docs/DECISIONS/` for 8 ADRs covering:
- Plugin surface (ADR-001)
- Non-blocking setup (ADR-002)
- Role injection (ADR-003)
- SQLite persistence (ADR-004)
- Command display (ADR-005)
- Dependency index + skip (ADR-006)
- Session executor (ADR-007)
- Verification + approval gates (ADR-008)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests first (TDD)
4. Ensure `bun test test` and `bunx tsc --noEmit` pass
5. Update documentation (README, traceability, ADRs)
6. Submit a PR with honest status (no unverified claims)
