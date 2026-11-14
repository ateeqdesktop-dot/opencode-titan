# TITAN — Security

## Overview

TITAN implements defense-in-depth for multi-agent orchestration:

1. **Secret redaction** — credentials never reach durable state
2. **Least-privilege tools** — roles get only the tools they need
3. **Session-scoped permissions** — deny lists enforced at session creation
4. **Isolated worktrees** — write-heavy roles work in isolated git worktrees
5. **Approval gates** — human approval for mutating work in supervised mode
6. **Recovery safety** — ambiguous state never auto-succeeds

## Secret Redaction (SEC-001)

All evidence summaries and journal payloads pass through `sanitizeForStore()` before
persistence. Detected patterns:

- API keys (`sk-*`, `AKIA*`)
- GitHub tokens (`ghp_*`, `gho_*`, etc.)
- Bearer tokens
- Password/secret/token assignments
- OpenCode server passwords

Secrets are replaced with stable masks (first 3 + `***` + last 3 chars).

**Module**: `src/security/redact.ts` (pure, unit-tested: `test/unit/redact.test.ts`)

## Least-Privilege Tools (FR-100/101)

Each role has an `allowedTools` list. At session creation, every interactive tool
(`write`, `edit`, `bash`, `webfetch`) NOT in the role's allowed list is denied
via session-scoped permissions with `effect: "deny"`.

| Role | Allowed Tools | Denied |
|---|---|---|
| Explorer | read, grep, glob | write, edit, bash, webfetch |
| Implementer | read, grep, glob, write, edit, bash | webfetch |
| Reviewer | read, grep, glob | write, edit, bash, webfetch |
| Test Engineer | read, grep, glob, bash | write, edit, webfetch |

**Module**: `src/execution/session-executor.ts` (`deniedToolsForRole()`)

## Worktree Isolation (FR-060)

Isolated-write roles (implementer, test-engineer) run in dedicated git worktrees.
Read-only roles run in the project directory. Changes are cherry-picked back to
the main tree on success. Worktrees are always cleaned up.

## Approval Gates (FR-102)

In supervised mode (`--supervised`), mutating task types (implementation, test,
integration) require human approval before execution:

- Approval record created (`APR-*`, 8h expiry)
- Task parks in WAITING_APPROVAL (no model call made)
- Human approves/rejects via `/titan approve` or `/titan reject`
- Rejected/expired → task FAILED, dependents SKIPPED

## Recovery Safety (NFR-010/011)

After a crash:
- Ambiguous RUNNING tasks → BLOCKED (never auto-succeed)
- WAITING_APPROVAL tasks are NOT touched (deliberate parking)
- Stale leases are expired
- Integrity issues are reported (never silently ignored)

## Audit Trail

All state transitions are journaled in an append-only event log:
- `run.created`, `run.transition`
- `task.assigned`, `task.transition`, `task.finished`
- `approval.requested`, `approval.decided`
- `verify.result`

Events are persisted in SQLite and survive restarts.
