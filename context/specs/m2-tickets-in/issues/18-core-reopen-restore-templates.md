# 18: Core: reopen, the restore spec and the templates

Status: ready-for-agent
Builder: core
Blocked by: 06, 12, 14, 17
Features: F-032, F-033, F-045, F-047, F-064
Packages: `apps/core` (`src/dispatch/`, `src/tracker/context.ts`), `packages/domain` (`reopenTask`, `chooseReopenStep`, `startTicketTask`)
Spec: `../spec.md`, sections 4 ("A ticket becomes a task", "Reopen") and 11 (items 5 to 9 and 12)

## What to build

- **`ticket.fetch-context`:** for a new ticket task, read the context through the adapter, copy each image into the blob store as a blob of the task (the caps of spec section 11, item 9), render the prompt with the project's template (or the built-in one), store it on the task, and enqueue `task.dispatch`. A failure to fetch an image leaves a line in the prompt saying so; the task still starts.
- **The branch and the PR text for a ticket task:** the branch name of spec section 11, item 5; the PR title `<KEY>: <ticket title>` and `Closes <KEY>` (or the board's word) in the body, beside the agent's text.
- **`reopenTask`:** a member's message becomes a `user.message` event and a pending message; a new session is created with no origin yet; the task moves with `reopen`; `task.dispatch` is enqueued. Refused while another active code task holds the ticket (spec section 11, item 12).
- **`chooseReopenStep`,** at dispatch: `resumed` when the chosen runner still holds the task's box in `idle` or `stopped`; else `restored` when the last archive exists, is under the cap and the agent declares `sessionArchive`; else `rebuilt`, with the rebuild template (ticket 06) as the spec's `prompt`. The step goes into the spec's `restore` section with the archive, each repo's hidden ref and its base, and the pending messages, including a member message a lost box never answered.
- **The task spec for minor 1** gains `ticket`, `contextFiles` and the new `limits`; a minor-0 runner gets milestone 1's shape and the reopen falls back to `rebuilt`.
- **`session.restored`** (ingest): store the origin on the session; `hiddenRef: "conflict"` raises the `restore_conflict` needs-you item (spec section 11, item 7) and the task carries on from the branch's head.

## Done when

- [ ] Tests: each of the three steps is chosen when it should be; a reopen raises the epoch and a write from the old box is refused; a lost box's unanswered message is in the next spec's pending messages exactly once; a deleted archive gives `rebuilt`; the rendered prompt keeps ticket text inside its blocks; a second active task for one ticket is refused.
- [ ] Spike 2's five-question fixture passes through `chooseReopenStep` and the template for the `rebuilt` case (4 of 5 or better).
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add reopening and ticket context`.

## Comments
