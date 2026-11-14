# TITAN — User Guide

> Complete reference for all TITAN commands and workflows.

## Quick Start

```
# 1. Plan a goal
/titan plan add a CONTRIBUTING.md file

# 2. Review the plan
/titan tasks <runId>

# 3. Execute
/titan run <runId>

# 4. Monitor
/titan status <runId>

# 5. Review results
/titan review <runId>
/titan report <runId>
```

## Commands

### Planning

#### `/titan plan [--supervised|-s] <goal>`
Creates a 6-step engineering plan (explore → plan → implement → test → review → integrate).

- `--supervised` / `-s`: Requires human approval before mutating tasks execute.

**Example:**
```
/titan plan add input validation to the signup form
/titan plan --supervised refactor the database layer
```

### Execution

#### `/titan run <runId>`
Starts executing a planned run. Tasks are scheduled according to DAG dependencies,
concurrency limits, and budget constraints.

#### `/titan status <runId>`
Shows current progress: task states, counts, worker activity.

#### `/titan tasks <runId>`
Lists all tasks with their status and assigned role.

#### `/titan agents`
Lists all available agent roles with their tools and suitable task types.

### Control

#### `/titan pause <runId>`
Pauses scheduling. In-flight tasks finish; no new tasks start.

#### `/titan resume <runId>`
Resumes a paused run.

#### `/titan cancel <runId>`
Cancels a run. In-flight tasks are interrupted; no new tasks start.

### Review & Verification

#### `/titan review [--deep] <runId>`
Evidence-based review: checks task completion, evidence presence, AC coverage,
roles, and approvals. Produces a verdict (PASS/FAIL/INCOMPLETE).

- `--deep`: Runs a model-assisted review session for a deeper analysis.

#### `/titan verify <runId>`
Re-runs verification gates on all tasks. Shows PASS/FAIL per task with reasons.

#### `/titan report <runId>`
Produces a full delivery report in Markdown: goal, status, task table, summary,
approvals, budget, and verdict.

### Approvals (Supervised Mode)

#### `/titan approve <runId>`
Approves all pending tasks in a supervised run. Execution resumes automatically.

#### `/titan reject <runId>`
Rejects all pending tasks. Dependents are marked SKIPPED.

### Diagnostics

#### `/titan doctor`
Checks OpenCode version, plugin registration, models, storage, git, permissions.

#### `/titan version`
Shows plugin and OpenCode version compatibility.

#### `/titan rpc <json>`
Executes an RPC request (for testing/integration). Example:
```
/titan rpc {"kind":"run.list"}
/titan rpc {"kind":"run.status","runId":"RUN-abc123"}
```

### Help

#### `/titan help`
Shows all available commands.

## Workflows

### Direct Mode (default)
1. Plan → 2. Run → 3. Review → 4. Report
All tasks execute automatically within budget and concurrency limits.

### Supervised Mode
1. Plan with `--supervised` → 2. Run → tasks park at WAITING_APPROVAL
3. Review parked tasks → 4. Approve/Reject → 5. Execution continues
6. Review → 7. Report

### Failure Recovery
- Failed tasks retry automatically (up to maxAttempts)
- Dependents of failed tasks are SKIPPED (never run on stale data)
- Ambiguous state after crash → BLOCKED (never auto-succeed)
- Budget exhaustion → PAUSED (resumable)

## Agent Roles

| Role | Tools | Suitable For |
|---|---|---|
| Orchestrator | read, grep, glob | planning, integration |
| Requirements Analyst | read, grep, glob | requirements |
| Repository Explorer | read, grep, glob | exploration |
| Architect | read, grep, glob | planning |
| Implementer | read, grep, glob, write, edit, bash | implementation, repair |
| Reviewer | read, grep, glob | review |
| Test Engineer | read, grep, glob, bash | test, repair |
| Security Auditor | read, grep, glob | review, exploration |
| Debugger | read, grep, glob, bash | repair |
| Integrator | read, grep, glob | integration |

## Budget & Limits

- **maxConcurrentWorkers**: 4 (default) — max parallel tasks
- **maxAttemptsPerTask**: 3 (default) — retries before permanent failure
- **maxTotalSeconds**: 3600 (default) — wall-clock budget per run
- **maxModelCalls**: optional — hard cap on model invocations
- **maxEstimatedCostUsd**: optional — cost budget

## Evidence

Every task produces evidence (diff, test, log, artifact, command). Evidence is:
- Sanitized for secrets before persistence
- Required for acceptance criteria marked `evidenceRequired`
- Required for implementation and test task types
- Tracked in the durable journal

## Recovery

After an OpenCode restart:
1. TITAN loads persisted state from `.titan/titan.db`
2. Verifies integrity (orphans, schema version)
3. Expires stale leases
4. Ambiguous RUNNING tasks → BLOCKED (never auto-succeed)
5. READY/QUEUED tasks with met dependencies → resumable
6. Budget exhaustion persists (run stays paused)

## Worktrees

Isolated-write roles (implementer, test-engineer) run in dedicated git worktrees.
Changes are cherry-picked back to the main tree on success. Worktrees are
always cleaned up after task completion.
