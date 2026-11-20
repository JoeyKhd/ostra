# 10: Core: the scheduler tick and occurrences

Status: done
Builder: core
Blocked by: 06
Features: F-106
Packages: `apps/core` (`src/automations/scheduler.ts`), `packages/jobs` (the tick's schedule), `packages/domain` (`tickScheduler`, `runOccurrence`)
Spec: `../spec.md`, section 4 ("A schedule"); ADR 0037 (amended), ADR 0056

## What to build

- **`scheduler.tick`,** a pg-boss schedule once a minute (idempotent, so pg-boss's own cron is fine for the tick itself, ADR 0037). In one transaction per due automation, read with `FOR UPDATE SKIP LOCKED`: insert the occurrence in `automation_run` with `ON CONFLICT DO NOTHING`, enqueue `automation.occurrence` keyed `automation:<id>:<ISO time>` through `enqueueInTx`, and advance `nextOccurrenceAt` with the domain's evaluator in the schedule's zone.
- **Late occurrences:** due times more than `OSTRA_SCHEDULE_MISSED_HOURS` late are inserted as `missed` with an audit entry each (one entry per automation and catch-up, listing the count); of those under the limit, only the latest fires.
- **`automation.occurrence`:** re-reads the automation (a pause, an edit or a delete since the tick wins: a paused or deleted automation's occurrence is recorded `skipped: paused`); with "skip while the last one is open", skips while the previous occurrence's task isn't merged, done or stopped; otherwise checks the rule's filter (starting each match the rule hasn't started, up to the bulk limit, each through `startTask` with the origin `occurrence`) or starts the schedule's prompt task.
- **Edits:** saving a schedule recomputes `nextOccurrenceAt` from now, so an edit takes effect at the next tick and never fires a past time.
- Each start passes admission, the pool cap and the budget as any start (`startTask`); an occurrence held by the budget leaves its task queued with the reason.

## Done when

- [x] Tests named `it("F-106: ...")`: each occurrence inserted once with its job in one transaction (a rolled-back transaction leaves neither); two ticks in parallel start each occurrence once; the 6-hour rule with the clock moved 3 and 7 hours; pause, edit and delete at the next tick; "skip while open"; a prompt schedule's task and a filter schedule's matches; the gates on each start.
- [x] Break-it: the `ON CONFLICT` dropped fails the parallel-tick test; recorded in `context/proof/F-106.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the scheduler tick`.

## Comments

- 2026-11-20, core: built as `✨ add the scheduler tick` (36dac0d4), on ticket 11's one start. The tick and the occurrence are `tickScheduler`, `tickAutomationInTx` and `runOccurrence` in `packages/domain/src/automations/scheduler.ts`; core's workers and the tick's pg-boss schedule (`* * * * *`, registered once by every replica) are in `apps/core/src/automations/automations.ts`; saving, pausing and deleting are in `packages/domain/src/automations/manage.ts` (ticket 24's router calls them). Readings:
  - A due schedule is locked `FOR UPDATE SKIP LOCKED` with its due time checked again, so two ticks never offer one occurrence. The `ON CONFLICT DO NOTHING` insert is the backstop for a tick that finds its occurrence recorded (a schedule's row set back). The parallel test covers that case, and it's the one the break-it fails.
  - Of several due occurrences, only the latest under `OSTRA_SCHEDULE_MISSED_HOURS` fires. The others (older, or over the limit) are recorded `missed`, with one `automation.occurrences-missed` audit entry per catch-up holding the count and the first and last times (at most 50 rows named, ticket 06's rule).
  - An occurrence is inserted `started` without a task. Its job sets the task, or records it `skipped`: `paused` for a paused, disabled or deleted automation, `last_open` while any task the automation started is open. When the project's setup refuses a prompt schedule's start (no repo, no model), the occurrence keeps no task and the next one tries again. A filter schedule's matches are recorded as the rule's `ticket_match` runs, so a ticket starts once per automation, as with a rule.
  - The gates act at the dispatch, as for any start. An automation's pool labels reach admission every time its task is queued (`starts/origin-labels.ts`, used by `dispatchTask` and `queueTask`).
  - Proof: `context/proof/F-106.md`. The hunt's row stays `missing` (ticket 37), and the "a few seconds late" row stays `partial` until the hunt measures a live install.
