# 19: Core: runaway timers, the stall sweep and spend

Status: in-progress
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

- [ ] Tests with a fake clock: the maximum duration fires once and never after the session ended; a cancelled job leaves nothing behind; the sweep stops a silent session within one minute of the limit and leaves a waiting one alone; usage is priced on all four kinds and summed across sessions; a model with no price counts tokens; each limit gives the right needs-you reason; a reopen at the cap is refused with its reason. *(All but the last are in `apps/core/src/limits/limits.test.ts`; the reopen's refusal lands with ticket 18's `reopenTask`.)*
- [x] Committed as `✨ add runaway timers and spend`.

## Comments
- 2026-11-20, core (sessions): the timers and spend are in `8ef050c` (`✨ add runaway timers and spend`), with an additive contract commit before it, `7ae1a52`-range `✨ add the model's cache-read and cache-write prices`: migration `20261120030000_model_cache_prices` adds `Model.cacheReadPricePerMTok` and `cacheWritePricePerMTok` (nullable), the catalog entry gains the two optional fields from models.dev's `cost.cache_read` and `cost.cache_write`, and the model sync writes them (Q163). The admin's price form (api) can add the two fields later; until then an unknown cache price is priced at the input price, which never undercounts a cache read. For tickets 18, 25, 30, 36 and 38:
  - **`recordLimitReached`** (`packages/domain/src/use-cases/sessions-m2.ts`) takes the task row `FOR NO KEY UPDATE` (ingest may hold it already), stops an active session (`limitReached` on its row), cancels its timer, sends `stop` (`runaway` for the maximum duration and the stall, `spend-cap` for the cap) to the lease's runner, moves the task by `limit_reached` and raises `stalled` or `spend_cap` for the driver with words and the number only (`limitSummary`). A core-timed limit is also recorded as core's own `session.limit_reached` event (no session number) through the new `appendCoreEvent` (`coreRecordedKinds`: `session.limit_reached` and `session.crashed`). A runner's `session.limit_reached` reaches it from ingest, which now takes an optional `outbox`.
  - **The maximum duration** (`apps/core/src/limits/limits.ts`): ticket 17 sends `session.max-duration` at each turn's start (the key keeps one per session) and cancels it when the session ends. The handler stops a session still in a turn (running or waiting) and leaves an idle one to the idle timer; the next turn then gets a fresh window.
  - **The stall sweep:** `session.stall-sweep` on a `* * * * *` schedule. A running session's last agent event is the newest `createdAt` of its events with a session number (the server's clock, never the runner's), and it's skipped while it has an open approval or an open `approval`, `question` or `plan` needs-you item. The candidate is re-read under the task's lock before it's stopped.
  - **Spend:** each `usage.recorded` is priced in ingest's transaction with the model's four prices (`modelTokenPrices`, `priceTokens` in `spend.ts`, rounded up to whole micro-USD) and added to the session's and the task's `spentMicroUsd`, clamped to the column. A model without both an input and an output price is counted in tokens only.
  - **The spec's `limits`** (`specLimits` in `apps/core/src/dispatch/task-spec.ts`, from `TaskEndpointDeps.specSettings`): `idleMinutes` from `OSTRA_BOX_IDLE_MINUTES` and `spendCap`, in micro-USD with the prices and the task's `spentMicroUsd` across sessions, or `{ capTokens, spentTokens }` with the task's tokens summed over its sessions. `spendCapReached` says when a reopen must be refused.
  - **Not here:** the progress comment's edit on a limit is ticket 15's writer.
