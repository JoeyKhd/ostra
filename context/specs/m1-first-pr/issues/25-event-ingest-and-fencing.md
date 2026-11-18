# 25: Event ingest, fencing and the task grace

Status: ready-for-agent
Builder: core
Blocked by: 23, 24
Features: F-023 (saving), F-045 (the fence, built in from milestone 1)
Packages: `packages/domain` (`ingestEvents`), `apps/core` (`src/ingest/`)
Spec: `../spec.md`, sections 4 and 5.1

## What to build

The body of `ingestEvents` (ticket 08's signature), and core's wiring.

- One transaction per batch: a **share lock on the task row** (ADR 0034 as amended), check the lease epoch (a stale epoch, or one the grace has ended, is refused: Q111), then for each event: skip it if `(sessionId, sessionSeq)` exists, otherwise take the task's next `seq` under the counter lock and insert it. A batch that doesn't start at the session's cursor plus one gets `resendFrom`.
- In the same transaction: apply the state changes the events imply through ticket 07's transitions (`turn.started` → running, `session.ended` → enqueue `task.session-ended`, `session.crashed` → needs you), store `usage.recorded` counts on the session, delete a live-text row whose segment completed, and emit change notices.
- After the commit: one `NOTIFY` wake per batch window (task IDs and highest `seq`, never content), and the ack.
- **Live text:** upsert the segment's row in the `UNLOGGED` table, at most every 250 ms per segment, without a transaction around anything else.
- **The task grace:** on a runner's disconnect, a delayed `task.grace` job at 10 minutes. When it fires and the runner hasn't reconnected: end the lease, raise the epoch, stop the task cleanly (→ stopped, ready to reopen in milestone 2). A reconnect before then cancels it.

## Port from

`spikes/live-stream-and-task-view/src/server/appender.ts`, `wake.ts`; `spikes/runner-transport/src/server/replica.ts` (ingest and fencing) and its `kill9`, `cuts`, `acks` scenarios as tests.

## Done when

- [ ] Tests: a resent batch stores nothing twice; a gap gets `resendFrom`; a stale epoch is refused; a grace sweep and an ingest run at the same moment and no stored row has an epoch behind its task's (F-045's contract test); live text is shown, then deleted when its message commits, and never stored as an event.
- [ ] An event that implies a refused transition is stored, and the refusal is logged with IDs only, never acted on.
- [ ] Every test checks another organization's task is untouched.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add event ingest and fencing`.

## Comments
