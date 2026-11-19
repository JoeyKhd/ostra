# 15: Core: the tracker writer, idempotency and rate budgets

Status: done
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

- [x] Tests against the fake Linear server and the Jira fake: each step writes once; a write applied and then answered with a 500 isn't repeated, and a control handler without the lookup does repeat it (F-046, ADR 0037); a replayed state change writes nothing new; "in review" moves only at the first PR; "done" only with `doneBy: ostra`; the progress comment is edited, never added again; a failed write leaves the task running.
- [x] Committed as `✨ add the tracker writer`.

## Comments

- 2026-11-19, core (m2-core-a): built. **Domain:** `postgres-plumbing.ts` has `postgresIdempotencyStore` and `postgresRateBudgetStore`, for one organization or with a resolver; `organizationOfGitHubKey` files the one server-wide GitHub adapter's keys (`app:<appId>`, `inst:<appId>:…`) under the organization whose App it is, so core's GitHub adapter now uses both stores (the panel's adapters in `apps/web/src/server/deps.ts` don't yet: a one-line change for the web or api builder). `tickets/ticket-writes.ts` has `writeTicketStepsInTx` (the outbox rows of a `TicketSyncTrigger`, `createManyAndReturn` with `skipDuplicates` on the fixed key, so a replay writes nothing), `recordTicketProgressInTx`, `retryTicketSyncInTx` ("Retry sync", for ticket 30) and `renderProgressComment` (state, PRs and the task's link: no ticket text, prompt or agent output). `moveTaskInTx` now writes a progress-comment edit with every move of a ticket task, and `openPullRequests` writes the PR's link, the first-PR move to in review and an edit in the transaction of its `pr.opened`. **For the other builders:** ticket 29's `startTicketTask` calls `writeTicketStepsInTx(..., { kind: "task-started", taskUrl, taskTitle })` (move to started, the comment, the task link) and "Create ticket" calls it with `create-ticket`; tickets 17, 19 and 23 call it with `{ kind: "progress", reason: "idle" | "crashed" | ..., revision }` for changes that aren't a task move. Pass `jobs` to send `ticket.sync` at once; without it, core's drain sends pending rows every 2 s. **Core:** `tracker/connections.ts` builds a connection's tracker with its token and the organization's Postgres stores (shared with ticket 14). `tracker/writer.ts` is `ticket.sync`: the row's key is claimed in the idempotency store; a recorded answer is reused; any retry (an earlier attempt, or a claim a dead attempt left) reads the tracker first: the comment holding the task's URL by the connection's own user, or for "Create ticket" a ticket whose description holds it. The comment is re-rendered from the task's current state when it applies, so edits out of order still leave the latest text, and an edit with a newer one pending is skipped as superseded. A write that fails for good, or on its last retry, is `failed` with its reason; the task's state is never touched. `link_pr` passes the board's magic word as the link kind. Hedged retries are ported from spike 5's `retry.ts` (`tracker/retry.ts`) for moves, edits and links; a create (the comment, "Create ticket") is never hedged and runs once per job run, because the tracker interface takes no client-made ID: the marker the next run looks for (the task's URL) is the ID ostra controls. An adapter-level client ID (Linear's `commentCreate` and `issueCreate` take an `id`) would let creates hedge too; it needs an additive optional parameter on `comment` and `createTicket`, left for the adapters builder. Tests: `writer.test.ts` (10 cases on the Jira fake, 2 on the fake Linear server, each F-046 case with its control that duplicates) and `stores.test.ts`.
- 2026-11-19, core (m2-core-a): committed as `51cbe18` (`✨ add the tracker writer`). Ticket 29's `startTicketTask` writes its own rows with the same keys (`ticketWriteKey`), which `ticket.sync` applies as these.
