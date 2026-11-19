# 17: Core: sessions across turns, saved work and idle

Status: done
Builder: core
Blocked by: 06, 12
Features: F-096, F-030, F-065, F-047
Packages: `apps/core` (`src/ingest/`, `src/reactions/`), `packages/domain` (`recordWorkSaved`)
Spec: `../spec.md`, section 4 ("After every turn", "The idle timer")

## What to build

Milestone 1 opened PRs on `session.ended`, because a session was one turn. From minor 1 a session spans turns.

- **`session.saved`** (ingest): store each repo's head, whether it's ahead, the hidden ref's commit and its base on the task repo, and the archive's blob on the session. Then `recordWorkSaved`: when a repo is ahead and has no PR, enqueue `task.open-pull-requests` (milestone 1's job, idempotent per task repo); when a PR exists, the push already updated it, and only the progress comment is edited (ticket 15); when nothing changed and no PR is open, raise milestone 1's needs-you item with the agent's summary (F-065). The task moves with `work_saved`.
- **The session goes `idle`** after `turn.ended`, and `ended` on `session.ended`, which a minor-1 runner sends when the idle timer stops the box. `session.ended` from a minor-0 runner keeps milestone 1's meaning.
- **A turn that waits on a person** when the idle timer fires: the runner cancels it and ends the session; the needs-you item stays open; answering it reopens the task with the decision (the answer goes in the reopen's pending messages, ticket 18).
- **A crash or a lost box:** `session.crashed`, or the grace ending (milestone 1's `task.grace`), leaves the task ready to reopen, with the last saved archive and hidden ref named on the task. The member's message that no turn answered is marked to be replayed by the reopen (spike 2, gotcha 10).
- **`unstorable_event`:** an event core can't store (it fails validation, or the database refuses it) is acked as refused once, stored as a server event saying so, and raises a needs-you item (M1's demo gap: "a batch the server can't store is resent forever"). The runner gets an `ack` past it, so the batch isn't resent.
- **Archives:** a `session.saved` without an archive (`null`) is fine; the session's last good archive stays the one to restore.

## Done when

- [x] Tests: two turns, the first without changes and the second with, open one PR after the second; a third turn with changes opens no second PR; a session idles between turns and ends on the timer; a minor-0 runner's `session.ended` still opens the PR; an unstorable event is refused once and the next batch is stored; every test checks another organization's task is untouched.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add sessions across turns`.

## Comments
- 2026-11-20, core (sessions): done in `b25a4c7` (`✨ add sessions across turns`). Whole-repo typecheck, lint, test and check:licenses green. For tickets 18 to 23 and 38:
  - **`recordWorkSaved`** (`packages/domain/src/use-cases/sessions-m2.ts`) runs in ingest's transaction on each `session.saved`. Each task repo gets `headSha`, `ahead`, `hiddenRefSha` and `hiddenRefBaseSha` (the head the hidden ref was saved on; a repo with no head yet records no hidden ref, since there's nothing to restore it onto). The session gets `archiveBlobId` and `archiveTurnOrdinal` when the archive isn't `null`. The session goes idle, the box goes `ready → idle` with `idleSince`. Then: a repo ahead whose state is `branch_pushed` (no PR) enqueues `task.open-pull-requests` keyed by the save's seq, and the opener moves the task to review as before; ahead or a PR open with nothing to open moves `work_saved` (the push already updated the PR); neither raises F-065's `no_changes` item with the agent's last message.
  - **The progress comment** isn't edited here yet: that's ticket 15's writer, which can hook in where `recordWorkSaved` returns `in-review` with a PR already open.
  - **Boxes now follow their lifecycle** (`moveBoxInTx`, `markBoxBusyInTx`): a turn's start makes a new box `ready` (milestone 1 left every box `creating` until it failed at the session's end) and an idle or kept stopped box `ready` again. `releaseLeaseInTx` and the grace set `stoppedAt`.
  - **`session.ended`:** `recordSessionEnd` reads a session with a stored `session.saved` as minor 1: the session ends (`box_stopped`), the lease ends, the box stops and is kept, and nothing else happens. Without one it keeps milestone 1's meaning (PRs or `no_changes`). Checking the stored event rather than the connection's minor also covers a minor-1 runner whose session ended before any turn finished.
  - **Timers** (`SessionTimers`, optional on ingest's, `recordSessionEnd`'s, the grace's and the reactions' deps; `startCore` builds it from the settings and `jobs.cancelInTx`): `session.max-duration` is sent when a session's first turn starts and cancelled when it ends, stops or crashes; `box.release-after-idle` is sent when a box goes idle (or stops) and cancelled when a turn starts in it. Their handlers are tickets 19 and 20.
  - **`unstorable_event`:** an `events` frame that fails to parse is salvaged (`salvageEventsFrame` in `apps/core/src/ingest/ingest.ts`): each event whose envelope reads but whose body doesn't is stored as milestone 1's placeholder (`agent.unknown`, `acpKind: "event-refused"`, its kind named only when ostra knows it), and the ack moves past it. A bad envelope, a server-only kind or a frame with nothing to refuse stays a protocol violation. Every placeholder, this one and the database-refusal one, raises one open `unstorable_event` item per task for the driver in the transaction that stored it. `GatewayHooks.ingest` takes an optional third argument, the refused events.
  - **The grace** no longer stops a task in review (or merged, or done) whose idle box's runner went away: the lease, the session and the box go, the epoch rises, and the task keeps its state, ready to reopen from its saved archive and hidden ref. A working task still stops with `runner_lost`.
  - **Not here:** the unanswered member message's replay is computed by ticket 18's reopen from the event log (a `user.message` no finished turn started after), so nothing is written to mark it at the crash or the grace.
