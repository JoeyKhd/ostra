# 10: Core: the scheduler tick and occurrences

Status: ready-for-agent
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

- [ ] Tests named `it("F-106: ...")`: each occurrence inserted once with its job in one transaction (a rolled-back transaction leaves neither); two ticks in parallel start each occurrence once; the 6-hour rule with the clock moved 3 and 7 hours; pause, edit and delete at the next tick; "skip while open"; a prompt schedule's task and a filter schedule's matches; the gates on each start.
- [ ] Break-it: the `ON CONFLICT` dropped fails the parallel-tick test; recorded in `context/proof/F-106.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the scheduler tick`.

## Comments
