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

## Done when

- [ ] The fold's tests run on recorded streams with every new kind, and nothing is dropped silently.
- [ ] Component tests for each box state, each limit, the reopen and send choice, and a failed sync.
- [ ] Committed as `✨ show tickets, reopening and limits on tasks`.

## Comments
