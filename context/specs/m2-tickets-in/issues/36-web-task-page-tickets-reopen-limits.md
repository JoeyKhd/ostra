# 36: Web: the task page for tickets, reopening and limits

Status: done
Builder: web
Blocked by: 30, 32 (the targets' approval, for the UI)
Features: F-064, F-031, F-032, F-033, F-047, F-068, F-097
Packages: `apps/web` (`src/components/tasks/`, `src/task/`), `packages/task-view` (the fold's new event kinds), `messages/en.json`
Spec: `../spec.md`, sections 3 (steps 5 to 9) and 12 (screens 5, 6, 7 and 11)

## What to build

To the approved targets for screens 5, 6, 7 and 11.

- **The ticket header:** key, title, status and a link to Linear; the context the agent got (collapsed by default), with the ticket's files; the sync state, one line per step with its state, and "Retry sync" when one failed.
- **The PRs per repo,** each with its state (open, merged, closed unmerged).
- **The box's state:** running, idle (with the time left before it stops), stopped, released.
- **Reopen:** the composer on a stopped, merged, idle or in-review task, or one that needs you, sends `tasks.reopen`; on a warm idle session it sends `tasks.send`. The button says which. Refusals show their reason.
- **The thread's markers** (the fold, in `packages/task-view`): "work saved" after a turn (the archive's size, the hidden ref), "resumed in the same box", "restored from the session archive" (with the replay count), "rebuilt from the template", a replayed message, a restore conflict, ticket files ready. Each renders, and an unknown kind still shows as `unsupported`.
- **Limits and crashes:** a stall, the maximum duration, the spend cap (spend against the cap, or tokens when the model has no price) and a crash, each as the needs-you item it raised, with its action (reopen, or why it can't yet).
- **"Create ticket"** on a prompt task when the project has a board.
- Milestone 1's gap: Stop no longer shows on a task in review.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **The one-click Reopen** on a limit or a crash calls `tasks.reopen` with no text. The thread then shows `Carry on from where you stopped.` as the member's message, tagged as a reopen (ticket 30).
- **A merged task:** the composer shows no Reopen. The hint reads `Its pull requests are merged. Start a new task from the ticket to change it again.` (new key `taskPage.composer.mergedHint`), and links to the ticket in the Inbox when there is one.
- **A restore conflict:** the status line reads `Running`. The conflict block shows in the thread and in Needs you, with `Show the saved work` and `Carry on without it` (`tasks.dismissNeedsYou`). `Stop` follows the running state.
- **The lost-box line and the reopen tag** read `session.restored.previousBox`, `session.crashed.cause` and `user.message.reopen` (ticket 02). When those fields are missing, the page shows milestone 1's crash line and no tag.
- **The driver after a reopen** is the member who reopened (ticket 18).
- **The reconnecting status** is `--muted` with `loader-circle` on every width, not amber.

## Done when

- [x] The fold's tests run on recorded streams with every new kind, and nothing is dropped silently.
- [x] Component tests for each box state, each limit, the reopen and send choice, and a failed sync.
- [x] Committed as `✨ show tickets, reopening and limits on tasks`.

## Comments

- 2026-11-19, web: built and committed (`✨ show tickets, reopening and limits on tasks`, `18ec167`) against ticket 30's `tasks.get`, `tasks.reopen`, `tasks.retrySync`, `tasks.dismissNeedsYou` and `tasks.createTicket`, with one additive API commit before it (`✨ give tasks.get's needs-you items their IDs`, `9e52c94`: `needsYou[].id`, which `tasks.dismissNeedsYou` needs and `tasks.get` didn't return).
  - **The fold** (`packages/task-view`): `session.saved` → `data-saved` (turn, archive size, hidden refs), `session.limit_reached` → `data-limit`, `ticket.files_ready` → `data-ticket-files`; `user.message`'s `reopen` and `replayed` reach the message's author meta. `session.restored` and `session.crashed` stay system rows, and the panel reads their minor-1 fields (`origin`, `replayedUpdates`, `hiddenRef`, `previousBox`, `cause`); without them it shows milestone 1's lines. Tested on the protocol's fixtures for every kind, plus a saved row and a reopen tag.
  - **The page** (`components/tasks/task-ticket.tsx`, wired in `task-view.tsx`): the ticket line (status, `Open in Linear`), `What the agent got` (collapsed, with the ticket's files), the idle header (`Idle, the box stops in 11 min`), Box and Spend rows, the Ticket and On Linear groups (one line per write with its state, `Retry sync`), each PR's state, the limit and crash blocks with the one-click Reopen (no text: the server writes `Carry on from where you stopped.`), the restore-conflict block (`Carry on without it` for the driver), `Create ticket` on a prompt task when the project has a board, and the composer: `tasks.send` on a warm session, `tasks.reopen` (`Reopen`) when `capabilities.reopen`, the merged hint with a link to the ticket in the Inbox. Stop follows `capabilities.stop` (false in review). The thread tags a reopen's message and a replayed one.
  - **Not done:** checked by component tests, not yet side by side with `task-ticket`, `task-reopen` and `task-limits` (the dev database had no ticket task to open, and making one needs a model provider and a runner). `Show the saved work` has no URL (the API doesn't give the hidden ref's commit). The sync lines name each write's kind, not its target status (`tasks.get` doesn't carry it). The phone layout (`phone-task`) is milestone 1's stacking.
- 2026-11-20, audit: **done**; every box held already, only the status was never set. Checked on `origin/main` (`58572d1`): `18ec1677` (`✨ show tickets, reopening and limits on tasks`) and `9e52c941` are there; `packages/task-view/src/fold.test.ts` (with the protocol's fixtures for every kind, the saved row and the reopen tag; the package's 124 tests pass) and `apps/web/src/components/tasks/task-ticket.test.tsx` (17 tests: each box state, each limit, the reopen and send choice, a failed sync) pass. The comment's "Not done" points (the side-by-side check, `Show the saved work`'s URL, the sync lines' target status, the phone layout) are outside this ticket's "Done when"; the side-by-side check of the task page against milestone 3's targets is ticket m3-43's.
