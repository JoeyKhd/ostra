# 37: Failure suite: the schedule hunt

Status: ready-for-agent
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

- [ ] The scenario passes three runs in a row on this machine, and its control fails each time; the log of the third is kept in `context/specs/m6-whole-team/demo/schedule-hunt.log` and cited in `context/proof/F-106.md` and `F-048.md`.
- [ ] Committed as `✅ add the schedule hunt to the failure suite`.

## Comments
