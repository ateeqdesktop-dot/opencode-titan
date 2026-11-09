# ADR-003: Role instructions injected via `session.hook("context")`, not agent registration

## Status
Accepted (R0 — `ctx.agent.transform` exposes no `add`)

## Context
TITAN has a catalog of agent roles (Orchestrator, Planner, Implementer, Reviewer, …). The intuitive approach is to register these as OpenCode agents. The installed `AgentEditor` only offers `list/get/default/update/remove` — **no `add`**. A plugin cannot create new agent definitions.

## Decision
Inject each role's system instructions, allowed tools, and model preference into a worker session at request time using `ctx.session.hook("context", …)` (and `ctx.session.switchModel` for model choice). Roles are TITAN-domain data (the Agent Registry), not OpenCode agent records. The hook appends role instructions to `event.system` and can restrict `event.tools` per role.

## Consequences
- Roles are fully owned by TITAN (typed catalog, policies, budgets) and portable across sessions.
- Least-privilege tool restriction is enforced in the `context` hook by removing tools a role may not use.
- We do not mutate the user's global agent config; TITAN's roles are self-contained.

## Alternative considered
Defining agents in `opencode.json` — rejected: it edits user config, couples TITAN to config layout, and cannot express per-task dynamic roles.
