# 13: Core: budget notices and their release

Status: ready-for-agent
Builder: core
Blocked by: 04, 12
Features: F-037, F-115
Packages: `apps/core` (`src/reactions/`, the notification fan-out), `packages/domain` (`checkBudget`, `releaseHeldTurns`)
Spec: `../spec.md`, section 4 ("Spend and the gate"); ADR 0055, ADR 0050

## What to build

- **`budget.check`:** writes `BudgetNotice` for the budget, month and threshold if none exists, and fans out a `budget_warning` or `budget_reached` notification (milestone 3's fan-out) to the organization's admins, and for a project budget also to that project's admins: in the panel and by mail. The mail is a moment, so members' choices apply; its default is on for both kinds.
- **On save:** `setBudget` enqueues `budget.check` for the current month at once, so a budget set below what's spent warns or closes immediately.
- **`budget.release`:** when a budget is raised above the month's spend, or a new month begins (a pg-boss schedule at 00:05 UTC on the first), the held turns of that budget go in the order they were held, each through the gate again, writing `turn.released`; waiting tasks are re-offered to the scheduler.
- **The notice's text:** the budget's scope and month, the share spent, and a link to "Spend"; no task content.

## Done when

- [ ] Tests named `it("F-037: ...")`: one notice per budget, month and threshold, also when `budget.check` runs twice; the audiences; a raise releases held turns in order and a new month releases them all; a raise that's still below the spend releases nothing.
- [ ] Tests named `it("F-115: ...")`: the budget mails render and go through Resend's and SMTP's fakes.
- [ ] Committed as `✨ add budget notices and their release`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **The budget mails' button** (`email-account.md`): `Raise the budget`, since ticket 13's audiences are the admins of the budget's scope. A later audience that can't raise it gets `Open Spend` instead.

## Comments
