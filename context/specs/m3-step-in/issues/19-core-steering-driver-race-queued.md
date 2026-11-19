# 19: Core: steering, the driver race and queued messages

Status: done
Builder: core
Blocked by: 07
Features: F-024
Packages: `packages/api` (`routers/tasks.ts`, its tests), `apps/core` (`src/ingest/`)
Spec: `../spec.md`, section 1 ("Steering is mostly built"); ADR 0036, ADR 0032

## What to build

Milestone 1 built Send, "Interrupt and send" and take over. This ticket finishes them.

- **The race test** (ADR 0036): a take-over and a send at the same moment, 50 times in a loop on a real Postgres, where every send either committed before the take-over (its message is in the log, attributed to the old driver) or was refused with `FORBIDDEN`; the same for an interrupt. Port the watcher checks from `spikes/live-stream-and-task-view/src/harness/checks-api.ts`. If the test fails, fix the read of the driver so it happens under the task's counter lock, inside the transaction.
- **Queued messages for everyone:** when the session's agent can't steer mid-turn, the `user.message` is stored with delivery `queued`, and the runner's later delivery is recorded so the thread shows "queued" to every viewer until it's sent, then "delivered after the turn".
- **Intents:** `tasks.send` takes an optional `intent` for the panel's own actions (update branch, diff comments, keep working, fix checks), validated against the protocol's set, and passes it to the `steer` command and the `user.message` event.
- **A message to a task with no session going** is a reopen, as milestone 2's composer already does; nothing changes there.
- **Capabilities for the panel:** the task's capabilities say whether the agent steers mid-turn, so the composer's hint reads right (ADR 0036's two hints).

## Done when

- [x] Tests: the race test passes 50 of 50; a watcher's send and interrupt are refused by the API; a queued message's state moves from queued to delivered in the log; an unknown intent is refused.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api` and `core`.
- [x] Committed as `✅ close the driver race on send`.

## Comments

- 2026-11-19: done in `✅ close the driver race on send`. Milestone 1 already read the driver under the task's lock in `tasks.send` and `tasks.interrupt`, so the race test passed as written: 50 of 50 for each, with both outcomes seen (one run: 47 sends committed before the take-over, 3 refused). Its break-it read the driver before `lockTask` inside the same transaction, and both races failed. Choices made here:
  - **Queued, then delivered:** `tasks.send` writes `immediate` only when the session's turn is running and its agent steers mid-turn (`agentSteersMidTurn`); otherwise `queued`. The runner's later delivery is the `turn.started` it records in that session after the message, so nothing new is stored: `messageDeliveries` (`packages/protocol/src/events/message-deliveries.ts`) reads each message as `delivered`, `queued`, `delivered-after-turn` or `after-interrupt` from the log, and the fold carries it as `author.deliveryState` for the thread (ticket 43 shows it).
  - **Intents:** `tasks.send` takes `intent`, checked against the protocol's `messageIntentSchema`, and passes it to the `steer` command and the `user.message`.
  - **`tasks.get`** says `capabilities.steersMidTurn` for the composer's two hints.
  Tests: `packages/api/src/routers/steering.test.ts` (six cases on a real Postgres) and a fold case in `packages/task-view/src/fold.test.ts`, each with a break-it (in `context/proof/F-024.md`).
