# 11: Core: intake rules, the dry run and bulk starts

Status: done
Builder: core
Blocked by: 06
Features: F-011, F-107, F-010
Packages: `apps/core` (`src/automations/intake.ts`, `src/starts/bulk.ts`, `src/starts/start-task.ts`), `packages/domain`
Spec: `../spec.md`, section 4 ("An intake rule", "The dry run", "A bulk start"); ADR 0056

## What to build

- **`startTask`'s body,** the one start every origin uses: the one-active-code-task index (milestone 2), the profile the origin allows, `poolOnly` for outside tasks, the pool labels into admission (milestone 5), the audit entry, `automation.started` in the thread for a rule's start. Milestone 2's Inbox start and milestone 1's prompt start move onto it in this ticket, with their tests unchanged.
- **`intake.match`:** enqueued in milestone 2's ticket ingest transaction for every upserted ticket whose project has an enabled rule without a schedule. It evaluates each such rule and, for a match, inserts the `ticket_match` run with `ON CONFLICT DO NOTHING`; only an inserted row starts a task. A ticket that stops matching and matches again starts nothing.
- **The hourly limit:** inside the match's transaction, the rule's starts in the last hour are counted under a lock on the rule; the one over `OSTRA_INTAKE_STARTS_PER_HOUR` pauses the rule (`hourly_limit`), records the match `skipped: hourly_limit`, and writes an `automation_paused` needs-you item for the project's admins.
- **"Wait for approval"** on a rule makes its tasks start `awaiting_approval` (ticket 14's path), whoever made the ticket.
- **`dryRunAutomation`:** the rule over the board's cached open tickets, each with what a start would do.
- **Bulk starts:** `startMany` writes `BulkStart` and its items in one transaction, idempotent by the member's request key, refuses more than `OSTRA_BULK_START_MAX`, and enqueues `bulk.start-item` per item; each item runs `startTask` in its own transaction and records `started`, `skipped` (with the reason: has a task, no access, a sub-issue parent over the limit) or `failed`. "Start all" from a dry run is a bulk start with the rule as each task's origin.

## Done when

- [x] Tests named `it("F-011: ...")`: each filter field starts what it matches and a near miss doesn't; once per ticket per rule under a replayed webhook, a poll racing the webhook, and two workers; the rule's kind, profile and pool labels reach the task and admission; no repo in a rule; the hourly limit pauses; "wait for approval".
- [x] Tests named `it("F-107: ...")`: 50 started, 51 refused; a replayed request starts nothing twice; each started task goes through admission, the pool cap and the budget, and a held one is queued with its reason; outcomes per ticket.
- [x] Break-it: the match row's `ON CONFLICT` dropped, and the bulk request key ignored, each fail their test; recorded in `context/proof/F-011.md` and `F-107.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add intake rules and bulk starts`.

## Comments

- 2026-11-20, core: built as `✨ add intake rules and bulk starts` (86b73f62). Readings and differences:
  - **The one start** is `startTask` in `packages/domain/src/starts/start-task-body.ts`. It keeps ticket 06's signature; its result now also carries the session and the branch, and its refusals include the ones milestones 1 to 4's starts had. Milestone 1's `createPromptTask` and milestone 2's `startTicketTask` now check the member's access and hand over to it, with their tests unchanged (core's, api's and domain's suites pass). The branch claim moved to `use-cases/branch-claim.ts` and the outbox write to `tickets/ticket-outbox.ts`, re-exported from where they were. Ticket 14's outside start (`apps/core/src/starts/outside.ts`) was built before this landed and still makes its own task; ticket 13 can move it onto `startTask` with the `linear` origin.
  - **`intake.match`** is enqueued in milestone 2's ingest transaction (the webhook's `ingestTicketHint` and each poll page) for every ticket row the read changed whose project has an active rule. Its key is the ticket and its tracker time, and ostra's own echo isn't matched. Only an inserted `ticket_match` row starts a task. When the project's setup refuses a start (no repo, no model), its row is deleted, so the ticket's next change tries again.
  - **The hourly limit** counts the rule's starts in the last hour under the rule's row lock. Difference: the pause writes an `automation_paused` **notification** for each of the project's admins (`budgetAudienceInTx`), not a needs-you item, because a needs-you item needs a task.
  - **"Wait for approval"** starts the task `awaiting_approval`, with an `awaiting_approval` needs-you item for the project's members (ticket 14's path). Nothing reaches the ticket or a runner until it's approved.
  - **The dry run** lists the matching open tickets of the project's boards (at most 500), each `would-start` (with the start rule) or `would-skip` (`has-task`, `matched-before`).
  - **Bulk starts**: `startMany` and `startBulkItem` in `packages/domain/src/starts/bulk.ts`, idempotent by member and request key. An item's outcome is `started`, `skipped` (`has-task`, `no-access`, `not-on-a-board`, `matched-before`, `automation-deleted`, `has-sub-issues`) or `failed` (the refusal's code). A dry run's "Start all" starts what the rule would: its kind, its profile unless the member chose one, and its labels. It records a `start_all` run, and each ticket as the rule's one match. Its tasks keep `origin: member` with the rule's `automationId`, since a member pressed it.
  - Proof: `context/proof/F-011.md` and `context/proof/F-107.md`. F-011's first row stays `partial` for the tracker's own project, which the cache has no column for yet. F-107's first row stays `partial` until the Inbox and the dry run's button reach `startMany` (tickets 25 and 32).
