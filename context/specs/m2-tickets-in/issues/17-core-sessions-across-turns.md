# 17: Core: sessions across turns, saved work and idle

Status: ready-for-agent
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

- [ ] Tests: two turns, the first without changes and the second with, open one PR after the second; a third turn with changes opens no second PR; a session idles between turns and ends on the timer; a minor-0 runner's `session.ended` still opens the PR; an unstorable event is refused once and the next batch is stored; every test checks another organization's task is untouched.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add sessions across turns`.

## Comments
