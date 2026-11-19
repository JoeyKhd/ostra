# 19: Core: runaway timers, the stall sweep and spend

Status: ready-for-agent
Builder: core
Blocked by: 01, 06, 17
Features: F-068
Packages: `apps/core` (`src/limits/`), `packages/domain` (`recordLimitReached`)
Spec: `../spec.md`, sections 5.1 (`limits`, `session.limit_reached`), 5.4 (jobs) and 11 (item 8)

## What to build

ADR 0037 puts the maximum duration and the stall on the server; the key proxy enforces the spend cap (ticket 25).

- **The maximum duration:** when a session starts, one delayed job `session.max-duration` keyed `session:<SessionId>:max-duration`, at `OSTRA_SESSION_MAX_MINUTES` (120). It wakes, checks the session's state, and does nothing if the session has ended; it's cancelled when the session ends. If the session still runs, core sends `stop` with reason `runaway` and records `session.limit_reached { limit: "max-duration" }` as its own event.
- **The stall sweep:** `session.stall-sweep`, one keyed job a minute, reads each running session's last stored event time from ostra's tables, and stops any session past `OSTRA_SESSION_STALL_MINUTES` (10) the same way, with `"stall"`. So 10 minutes are 10 to 11. A turn that waits on a person isn't a stall; the idle timer handles it.
- **Spend:** each `usage.recorded` is priced with the model's four prices (fresh input, output, cache reads, cache writes: Q163) from the catalog, or the admin's custom price, and added to the session's and the task's `spentMicroUsd` in the ingest transaction. A model with no known price is counted in tokens (spec section 11, item 8).
- **The spec's `limits`:** `idleMinutes` from the setting, and `spendCap` with the cap (`OSTRA_TASK_SPEND_CAP_USD`, 25), what the task has already spent, and the prices, or the token form (`OSTRA_TASK_TOKEN_CAP`). A reopened task carries what it spent, so the cap holds across sessions.
- **`session.limit_reached`** from either side: `recordLimitReached` ends the session cleanly (the runner pushes the hidden ref on the `stop`), moves the task with `limit_reached`, raises the needs-you item (`stalled` for a stall or the maximum duration, `spend_cap` for the cap), and edits the progress comment (ticket 15). A reopen at the cap is refused until the cap is raised; milestone 2 raises it only through the setting, and the panel says so.

## Done when

- [ ] Tests with a fake clock: the maximum duration fires once and never after the session ended; a cancelled job leaves nothing behind; the sweep stops a silent session within one minute of the limit and leaves a waiting one alone; usage is priced on all four kinds and summed across sessions; a model with no price counts tokens; each limit gives the right needs-you reason; a reopen at the cap is refused with its reason.
- [ ] Committed as `✨ add runaway timers and spend`.

## Comments
