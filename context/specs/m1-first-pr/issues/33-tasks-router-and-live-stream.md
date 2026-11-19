# 33: Routers: tasks and the live stream

Status: done
Builder: api
Blocked by: 23, 30
Features: F-097, F-023, F-025, F-014 (picking the runner)
Packages: `packages/domain` (`createPromptTask`), `packages/api` (`src/routers/tasks.ts`, `src/stream/`)
Spec: `../spec.md`, sections 3 (steps 7 and 8) and 4

## What to build

- **`tasks.create`** (`createPromptTask`): project, prompt, and "run on" (the member's own personal runner, or the project's pools). One transaction: the task (kind `code`, source `prompt`, title from the prompt, the branch name of spec section 11, item 10), its first session with the project's default code profile, the task's co-author (the member), `user.message`, a change notice, and the `task.dispatch` job through the `enqueue-only` jobs instance. No ticket is created (F-097).
- **`tasks.list`** for a project, grouped by state in `domain-model.md`'s order (needs you, running, queued, in review), with what the agent is doing now, the runner, the driver and the age. **`tasks.get`**, **`tasks.history`** paged by turn, the newest 20 turns first, reading backwards (ADR 0036).
- **`tasks.stop`** (`stopTask`, ticket 27's body; until it lands, this writes the outbox row through the port). Members of the project only.
- **`runners.mine`** for the "run on" picker and the checklist, and **`runners.list`** for admins.
- **The stream:** one tRPC subscription over SSE per tab (`stream.subscribe`), multiplexing change notices for the member's organization and, for the open task, its events and live frames.
  - One tailer per web process: one `LISTEN` connection, wakes on core's `NOTIFY`, polls about every 250 ms when none arrive, one query for `seq > cursor` across the tasks it has watchers on.
  - Committed events yielded with `tracked(seq)`; it subscribes before it catches up, so nothing slips. Live frames untracked: a snapshot of the current partial first, then deltas.
  - A named `ping` every 15 s. The client side (ticket 38) reconnects after 20 s without a frame (ADR 0035).
  - Every message filtered by organization and project access before it's yielded, and the membership re-checked on a timer.

## Port from

`spikes/live-stream-and-task-view/src/server/tailer.ts`, `sse.ts`, `wake.ts`, `server.ts`, and `src/harness/checks-api.ts` (resume, no gap, no duplicate, watcher can't send) as tests.

## Done when

- [x] Tests: a task created by one member is visible to another member of the project and invisible to another organization; history pages by turn; a stream resumed with `Last-Event-ID` has no gap and no duplicate; live text appears and is replaced by its committed message; a revoked membership closes the stream.
- [x] A test with two web-process tailers on one database: both viewers get the same events in the same order.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the tasks router and live stream`.

## Comments

- 2026-11-18 (api): done in `75874fd` (`✨ add the tasks router and live stream`) and `71e9a59` (`✅ test the stream over HTTP and the runtime`). `createPromptTask` and `stopTask` are written in `packages/domain`: ticket 27 names `stopTask`, but the router needed the panel's half (the task to stopped, a `stop` command for the runner holding the lease, a session that never had a runner ended, a notice), so it is here and ticket 27 keeps what happens on the runner's side. `tasks.send`, `tasks.interrupt`, `tasks.takeOver` and `approvals.answer` are in too, with the one-driver rule enforced under the task's row lock; a race test of a take-over against a send shows the send committing first or being refused. A watcher can't send by the API.
- The stream (`packages/api/src/stream/`): one hub per web process with one `LISTEN` connection and a 250 ms poll, one query for `seq > cursor` across the watched tasks, and a subscription that registers with the hub before it catches up. Tests: resume with `Last-Event-ID` (no gap, no duplicate, also while events commit during the catch-up), live text snapshot then deltas then replaced by its message, a revoked membership and a lost project role closing the stream, change notices filtered by organization and project, two hubs on one database with polling nearly off (the second hub woken by `NOTIFY` only), and 40 watchers costing a handful of queries.
- Closes ADR 0035's open item about tRPC: its SSE keeps `Last-Event-ID` across untracked frames. The server sends an empty `id:` with an untracked event, which would clear a browser's id, and then a `restore-id` event that sets it back; `stream.http.test.ts` reads the real `text/event-stream` bytes and checks that a browser's last id is still the last committed seq. The client link also keeps its own `lastEventId` and sends it as input on reconnect. A viewer that falls 50,000 messages behind gets `SERVICE_UNAVAILABLE`, which tRPC's client retries from its last id; losing membership is `FORBIDDEN`, which it doesn't retry.
- Findings for the maintainer: (1) the branch name's first 8 characters of a UUIDv7 are a millisecond timestamp prefix that changes only every 65 s, so two prompt tasks with the same title within a minute get the same branch name (spec section 11, item 10); the slug differs in practice. (2) `approval.closed` is a runner-written kind, so a deny doesn't close the session's other open approvals in the panel's transaction: the runner reports each, and the other approvals close when core saves them. (3) Core's `register` accepts only `bootstrap` join tokens in milestone 1, so the join tokens `pools.createJoinToken` makes (stored with the same SHA-256 hash) don't register a runner until core relaxes that (F-091, milestone 5). (4) A runner can be revoked only from `draining` in the lifecycle, so there is no `runners.revoke` yet.
