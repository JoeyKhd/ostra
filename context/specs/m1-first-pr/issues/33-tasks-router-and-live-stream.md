# 33: Routers: tasks and the live stream

Status: ready-for-agent
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

- [ ] Tests: a task created by one member is visible to another member of the project and invisible to another organization; history pages by turn; a stream resumed with `Last-Event-ID` has no gap and no duplicate; live text appears and is replaced by its committed message; a revoked membership closes the stream.
- [ ] A test with two web-process tailers on one database: both viewers get the same events in the same order.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the tasks router and live stream`.

## Comments
