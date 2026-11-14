# TITAN — Multi-Agent Engineering Orchestration for OpenCode V2

TITAN turns OpenCode into a multi-agent engineering team. It plans a goal into a
DAG of specialist tasks (explore → plan → implement → test → review → integrate),
routes each to a suitable role with least-privilege tool access, runs real worker
sessions in isolated git worktrees, verifies evidence before declaring success,
and produces a delivery report.

## Install

```sh
# From the project directory (local plugin, as used in development):
cd your-project
# Add to opencode.json:
# { "plugins": ["path/to/opencodeagent"] }
```

Or publish to npm and install via OpenCode's plugin mechanism.

## Commands

| Command | Description |
|---|---|
| `/titan plan [--supervised] <goal>` | Create a 6-step engineering plan (optionally supervised) |
| `/titan run <runId>` | Execute a planned run |
| `/titan status <runId>` | Show progress |
| `/titan tasks <runId>` | List tasks and assignments |
| `/titan agents` | List agent roles |
| `/titan pause <runId>` | Pause scheduling |
| `/titan resume <runId>` | Resume scheduling |
| `/titan cancel <runId>` | Cancel a run |
| `/titan review [--deep] <runId>` | Evidence-based review (+ optional model-assisted) |
| `/titan verify <runId>` | Re-run verification gates |
| `/titan report <runId>` | Produce a delivery report |
| `/titan approve <runId>` | Approve pending supervised tasks |
| `/titan reject <runId>` | Reject pending supervised tasks |
| `/titan doctor` | Diagnose compatibility |
| `/titan version` | Show version |

## Architecture

- **Server part** (`src/index.ts`): plugin entry, command dispatch, display recipe
- **Orchestration** (`src/orchestration/`): DAG, state machines, scheduler, recovery
- **Execution** (`src/execution/`): real worker sessions via `session.prompt` + `session.wait`
- **Verification** (`src/verification/`): evidence presence gates
- **Security** (`src/security/`): secret redaction before persistence
- **RPC** (`src/rpc/`): typed, versioned contract for server↔TUI
- **TUI** (`src/tui.ts`): TUI plugin skeleton (compiles; runtime unverified)

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test test       # 166 tests
```

## Verification status

See `docs/READINESS.md` for the honest readiness verdict and `docs/IMPLEMENTATION_STATUS.md`
for the phase-by-phase status. ADRs in `docs/DECISIONS/`.

## License

MIT
