# 37: Failure suite: the schedule hunt

Status: done
Builder: core
Blocked by: 10
Features: F-106, F-048
Packages: `e2e/m2-failure-suite/` (a new scenario), `packages/jobs/testing`
Spec: `../spec.md`, sections 8 and 9.1; ADR 0037 (amended)

## What to build

Spike 8's C4 hunt, ported against ostra's scheduler tick, in milestone 2's failure suite:

- 200 automations created at runtime, each with a schedule every minute, on one database with three `apps/core` processes.
- For several ticks, every replica but one is killed **at the moment a tick's occurrences are being inserted or forwarded, aimed at the replica holding the work** (the kill is triggered from inside the tick's transaction through a test hook, never by the clock), then started again.
- The check: each (automation, occurrence) pair started exactly once, read from `automation_run` and from the tasks created (no runner is needed: a started task waits queued), with a control run of pg-boss's own cron doing the same work that must show the duplicates spike 8 found.
- A late-start case: the processes stopped for 7 hours of fake clock, then one fires per automation for the latest occurrence and the rest are `missed` with their audit entries.

## Port from

`spikes/durable-queue-choice/` (the C4 hunt, its kill points and its control).

## Done when

- [x] The scenario passes three runs in a row on this machine, and its control fails each time; the log of the third is kept in `context/specs/m6-whole-team/demo/schedule-hunt.log` and cited in `context/proof/F-106.md` and `F-048.md`.
- [x] Committed as `✅ add the schedule hunt to the failure suite`.

## Comments

- 2026-11-20, core: built as `✅ add the schedule hunt to the failure suite` (3502faca). The hunt is core's own test file, `apps/core/src/schedule-hunt.test.ts` (run with `OSTRA_SCHEDULE_HUNT=1`, skipped in CI), with the scenario in `src/testing/schedule-hunt.ts`; the failure suite runs it as its `schedule-hunt` case (`e2e/m2-failure-suite/src/cases/schedule-hunt-case.ts`), and `pnpm e2e:schedule-hunt --runs 3 --record` runs it on its own. Three runs in a row passed (1,600, 1,600 and 1,200 pairs each started once; after 7 hours down, 200 of 200 automations fired once for the latest occurrence with their audit entries), and the control on pg-boss's own cron failed each time (68, 68 and 106 starts replayed after the 15-minute expiry; 139 of 600 pairs missed their tick in the third). The third run's log is `context/specs/m6-whole-team/demo/schedule-hunt.log`, cited in `context/proof/F-106.md` and `F-048.md`. Readings and choices:
  - **The kill points** are core's (`apps/core/src/kill-points.ts`): `scheduler.tick-written` and `automation.occurrence-started` are called from inside the domain's transactions through a new optional `onStep` on `SchedulerOptions` (additive; core passes its kill points, which do nothing unless armed), and `automation.occurrence-committed` is in core's occurrence handler after the commit. A point is armed for its Nth pass, over stdin (`CORE_TEST_CONTROL_STDIN=1` in `restart-child.ts`), on every replica but a rotating survivor; the replica that reaches it holds the work, prints one line and ends itself, and the harness kills the other at once. The late start moves only the scheduler's clock (`CORE_TEST_SCHEDULER_CLOCK_OFFSET_MS`, a test option of `startCore`).
  - **`packages/jobs/testing`** (new export): `replicaSet` starts, kills (at once, then the whole tree) and restarts processes by name; `runCronControl` is the control, ported from spike 8's C4, and `cron-control-replica.ts` its replica (raw pg-boss with its defaults, which only this package may import).
  - **"Started exactly once"** is read three ways: one `automation_run` row per (automation, minute) with no minute missing between an automation's first and last, `started` with its task; one `automation.started` event per pair, in that task; and as many tasks as started pairs, all queued.
  - **The control's work** is one recorded start per fire, as spike 8's (a task per fire would go through ostra's own occurrence row, which is what's under test).
  - **Found on the way:** `minimumIntervalOk` walked 13 months of minutes per save, so 200 saves at a one-minute interval hung; it now answers at once at one minute (its test has the case). And the start's lateness: occurrences were written 8 to 21 s after the minute at p50 and up to 34 s at p95, because pg-boss's cron pass that sends the tick runs every 30 s. F-106's "a start comes a few seconds late" stays `partial`; shortening `cronMonitorIntervalSeconds` in `packages/jobs` is a follow-up, not done here.
  - **Break-it:** `runOccurrence` taking a replayed job's occurrence for undecided made 3 of 90 pairs start twice, and the hunt failed; restored before the runs.
  - Windows only, on one loaded machine with an embedded Postgres; Linux and Postgres 16/17 runs are extra (spec section 9.1).
- 2026-11-22, models-spend-schedules review: the follow-up above is done. `packages/jobs` now runs pg-boss's cron pass every 2 s and its forwarding poll every 1 s (`CRON_PASS_SECONDS` and `CRON_FORWARD_POLL_SECONDS`, 43e4ae82), and `apps/core/src/automations/schedule-lateness.test.ts` (`F-106/c6`) runs in CI: a task starts under 10 s after its minute (4.2 s measured, 20.1 s with the old 30 s and 5 s). The hunt's case is now keyed `F-106/c4`. It still runs only with `OSTRA_SCHEDULE_HUNT=1`, which only `proof.yml`'s failure-cases job sets, so c4 waits for the launch-gate proof run; `ci.yml` doesn't run it (the maintainer's CI scope).
