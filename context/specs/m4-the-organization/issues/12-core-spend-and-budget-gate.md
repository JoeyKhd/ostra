# 12: Core: spend rollups and the budget gate

Status: ready-for-agent
Builder: core
Blocked by: 06
Features: F-037
Packages: `apps/core` (`src/ingest/`, `src/dispatch/`, every turn start), `packages/domain` (`recordSpend`, `budgetGate`, `checkBudget`)
Spec: `../spec.md`, section 4 ("Spend and the gate"); ADR 0055, ADR 0042

## What to build

- **The rollup:** milestone 2's pricing of `usage.recorded` also upserts `SpendDaily` for the task's project, the UTC day and the model, in the same transaction; a call with no price adds to `unpricedTokens`. When the month's total for the project's budget or the organization's crosses the warn threshold or 100%, it enqueues `budget.check` keyed by budget, month and threshold (ticket 13 sends the notice).
- **The gate at every turn start:** the dispatch of a new task, a reopen, a member's message to an idle session, a diff-comment send, update branch, an `@ostra` comment, "Keep working", a closing turn, and the origin `automatic-round` that milestone 6 will use. Each calls `budgetGate` with its origin, inside the task's lock.
- **When it's closed:** a new task stays queued with the dispatch note; any other origin saves its message as pending (milestone 2's reopen pending messages), writes a `HeldTurn` and a `turn.held` event, and starts nothing. A running turn is never interrupted, and a steer to a running session is still delivered: it's part of the current turn.
- **Unpriced models:** where a budget applies, a task whose model has no price waits with the reason "This model has no price, so the budget can't count it" (ADR 0055).
- **The overshoot:** the spend counted after the month's total passed 100%, kept per budget and month for ticket 27.

## Done when

- [ ] Tests named `it("F-037: ...")`: the rollup equals the sum of the tasks' spend for a month across sessions and a month's end; every origin is held at 100% and passes at 99% (the gate's table test, `automatic-round` included); a running turn finishes; a held message is saved and starts nothing; an unpriced model waits only where a budget applies; another project's budget holds nothing here.
- [ ] Break-it: the gate call removed from the reopen path fails its test; recorded in `context/proof/F-037.md`.
- [ ] Committed as `✨ add spend rollups and the budget gate`.

## Comments
