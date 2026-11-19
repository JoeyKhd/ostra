# 11: Core: intake rules, the dry run and bulk starts

Status: ready-for-agent
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

- [ ] Tests named `it("F-011: ...")`: each filter field starts what it matches and a near miss doesn't; once per ticket per rule under a replayed webhook, a poll racing the webhook, and two workers; the rule's kind, profile and pool labels reach the task and admission; no repo in a rule; the hourly limit pauses; "wait for approval".
- [ ] Tests named `it("F-107: ...")`: 50 started, 51 refused; a replayed request starts nothing twice; each started task goes through admission, the pool cap and the budget, and a held one is queued with its reason; outcomes per ticket.
- [ ] Break-it: the match row's `ON CONFLICT` dropped, and the bulk request key ignored, each fail their test; recorded in `context/proof/F-011.md` and `F-107.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add intake rules and bulk starts`.

## Comments
