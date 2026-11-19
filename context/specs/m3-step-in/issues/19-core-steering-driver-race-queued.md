# 19: Core: steering, the driver race and queued messages

Status: ready-for-agent
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

- [ ] Tests: the race test passes 50 of 50; a watcher's send and interrupt are refused by the API; a queued message's state moves from queued to delivered in the log; an unknown intent is refused.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `api` and `core`.
- [ ] Committed as `✅ close the driver race on send`.

## Comments
