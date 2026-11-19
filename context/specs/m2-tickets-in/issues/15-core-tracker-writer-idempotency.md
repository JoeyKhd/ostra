# 15: Core: the tracker writer, idempotency and rate budgets

Status: ready-for-agent
Builder: core
Blocked by: 06, 07
Features: F-031, F-046, F-097
Packages: `apps/core` (`src/tracker/writer.ts`), `packages/domain` (Postgres ports)
Spec: `../spec.md`, sections 4 ("Ticket sync") and 11 (items 4 and 5)

## What to build

- **Postgres `IdempotencyStore` and `RateBudgetStore`,** behind the plumbing's interfaces, on `IdempotencyRecord` and `RateBudget`. Every adapter the server holds uses them, the GitHub one included.
- **The writer:** each step F-031 maps writes a `TicketWrite` row in the same transaction as the change that causes it:
  - the task starts → move to the board's "started", the progress comment ("ostra is working on this", the task's link), the task link attachment
  - a PR opens → link the PR, move to "in review" at the first PR only, edit the progress comment
  - a PR merges → move to "done" only when the board's `doneBy` is `ostra`; edit the progress comment
  - a reopen, an idle box, a stop, a crash → edit the progress comment
  - "Create ticket" on a prompt task → create the ticket, then link the task
- **`ticket.sync`** applies one row through the adapter with the row's idempotency key (fixed by the task and the step, such as `task:<id>:moved:in-review`), stores the comment's ID on the task the first time, and marks the row done. A retry after a write that committed on Linear but whose answer was lost finds it done (the key, or a read before writing: a comment by ostra's user on the ticket with the task's marker), never writes twice.
- **The progress comment** is one comment per task, edited in place. Its text has the task's state, its PRs and links, never the agent's output or the prompt.
- **Failure:** a write that keeps failing after its retries is marked `failed`, shown on the task page, and retried by "Retry sync"; it never blocks the task.
- Hedged retries carry one client-made ID per write, ported from spike 5's `retry.ts`.

## Done when

- [ ] Tests against the fake Linear server and the Jira fake: each step writes once; a write applied and then answered with a 500 isn't repeated, and a control handler without the lookup does repeat it (F-046, ADR 0037); a replayed state change writes nothing new; "in review" moves only at the first PR; "done" only with `doneBy: ostra`; the progress comment is edited, never added again; a failed write leaves the task running.
- [ ] Committed as `✨ add the tracker writer`.

## Comments
