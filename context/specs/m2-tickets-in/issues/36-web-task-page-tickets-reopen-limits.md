# 36: Web: the task page for tickets, reopening and limits

Status: ready-for-agent
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

- [ ] The fold's tests run on recorded streams with every new kind, and nothing is dropped silently.
- [ ] Component tests for each box state, each limit, the reopen and send choice, and a failed sync.
- [ ] Committed as `✨ show tickets, reopening and limits on tasks`.

## Comments
