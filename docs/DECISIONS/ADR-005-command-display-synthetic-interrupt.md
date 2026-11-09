# ADR-005: Command output displayed via `session.synthetic` + immediate `session.interrupt`

## Status
Accepted (R1 — verified against OpenCode v2.2.5 via real server + API)

## Context
Plugin commands (`CommandDefinition.execute`) return `Promise<void>` — there is no return channel for text. TITAN must surface `/titan ...` output (status, doctor, help) to the user. OpenCode offers `session.synthetic` to inject a message into a session transcript.

## Findings (empirically verified, not assumed)

1. `session.synthetic` injects a visible `type:"synthetic"` message whose `text`/`description` appear in the transcript (verified via `GET /api/session/:id/message`).
2. **By default it triggers a model turn** (the synthetic message is delivered as input → the model responds; verified: 169 output tokens + 2 assistant messages on a default injection).
3. `resume: false` keeps the message in the **inbox** (pending) — it never commits to the transcript, so it is **not visible**. Unusable for display.
4. `delivery: "queue"` still triggers a model turn (just deferred). `delivery: null` is coerced to `"steer"` and still triggers.
5. **Timing window**: the message commits to the transcript at ~40ms; first model output arrives at ~3.4s. So: inject → poll until visible (bounded 1s) → `session.interrupt` → message stays visible, model turn cancelled, **zero model tokens**.
6. **Interrupting before commit cancels delivery** (message stuck in inbox, invisible). Hence the polling step is mandatory — a fixed delay is fragile.
7. Interrupting a session whose own run is in flight (`time.busy > time.idle`) would kill the user's work — the exact "unexpected session takeover" FR-107 forbids. In that case we use `delivery:"queue"` and **never interrupt**.

## Decision
- Display command output via `session.synthetic` + immediate `session.interrupt` when the session is idle, with a bounded poll (≤1s, 30ms cadence) for commit confirmation.
- If the session is busy, queue the message (`delivery:"queue"`) and do not interrupt.
- If no real session is available, fall back to `console.log` so output is never silently lost (FR-002, FR-007).
- Honest limitation: an interrupted model turn leaves an empty assistant message (`finish="error"`, no parts, no tokens) in the transcript — a cosmetic artifact. The R5 TUI/RPC layer (FR-004, FR-005) will provide a clean model-free status panel.

## Consequences
- Commands are fast and local (NFR-006): display commits at ~40ms, well under 250ms.
- No unrequested model cost or session takeover (FR-047, FR-107).
- `version` must be listed in `TITAN_SUBCOMMANDS` (parser allowlist) — fixed in R1.

## Evidence
- `src/index.ts` `display()`; real server test: 5 outputs visible, 0 inbox items, 0 model tokens, 5 "suppressed unrequested model turn" log lines.
- Timing measurement: visible at 40ms, first assistant at 3.4s (window 3.36s).
