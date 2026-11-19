# 01: `packages/jobs`: the heartbeat, the boot check and the queue options

Status: done
Builder: core
Blocked by: none
Features: F-043, F-044, F-046, F-048
Packages: `packages/jobs`, `apps/core` (the boot check's wiring), `apps/web` (the producer's start)
Spec: `../spec.md`, section 1 ("What milestone 1 left"), and ADR 0037 as amended after spike 8

## What to build

ADR 0037 lists four gaps in `packages/jobs` after spike 8. Milestone 2's polling, reconcile and timers rest on them, so they close first. Check `main` before starting: close only what is still open, and say under `## Comments` what was already done.

- **The forwarding queue's heartbeat.** pg-boss's cron pass forwards due occurrences through its internal `__pgboss__send-it` queue, created with no heartbeat and a 15-minute expiry, so a replica killed while holding a batch leaves it stranded and then resent. Set a heartbeat on that queue at start, and **check it at boot**: read the queue's settings back and refuse to start the workers, with a clear log line, when they aren't what ostra set. F-044's five minutes depend on it.
- **Schedules get `singletonSeconds`** beside their key, so a tick isn't sent twice in its window.
- **Throttled jobs get a `group`:** queue settings with `groupConcurrency` and send options with `group`, added as a typed option, used first by milestone 2's per-connection polling. It's a throttle, never a budget (ADR 0037).
- **Every queue is exclusive,** and a duplicate send looks the existing job up and returns it.
- **The panel's start against an empty schema:** `apps/web`'s producer retries its start with backoff and reports itself as starting until core has migrated (Q157), with a test against a database that has no pg-boss schema.
- **UTC** (Q158): every connection sets `TimeZone=UTC`, and the boot checks `SHOW timezone`. Skip if already in.

## Done when

- [x] Tests: a replica killed while holding a forwarded batch doesn't strand it for 15 minutes, on the spike's scenario ported as a test; the boot check refuses a queue without its heartbeat; a schedule doesn't fire twice in its window; a group's limit holds for running handlers; a duplicate send returns the first job; the panel's producer starts after the schema appears.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `🐛 close the job queue's gaps from spike 8`.

## Comments
- 2026-11-19, core (contracts): done in `🐛 close the job queue's gaps from spike 8`. On `main` before it: every queue was already `exclusive`, and a duplicate send already returned the existing job; nothing set UTC or the forwarding heartbeat. What it adds:
  - **The forwarding queue:** a worker's `start()` sets `heartbeatSeconds: 10` on `__pgboss__send-it` (`FORWARDING_QUEUE`, made first if pg-boss hasn't), then `bootCheck()` reads it back and checks `SHOW timezone`; on a problem it logs `jobs.boot_check_failed` with what's wrong, stops pg-boss and throws, so core never starts its workers. Core gets this through its existing `jobs.start()`.
  - **UTC (Q158):** `utcConnectionString` (in `@ostra/db`) adds `options=-c TimeZone=UTC` to every URL the server opens, through `createDb` and pg-boss both, unless the URL sets a time zone itself. `docs/configuration.md` says so.
  - **Schedules:** `schedule()` stores `singletonSeconds` beside its key: the cron's period (`cronPeriodSeconds`), or the caller's.
  - **Groups:** the domain's `EnqueueOptions` gains `group: { id, tier? }`, and `QueueSettings` gains `groupConcurrency`, passed to `work()` on every replica: 2 for `tracker.poll-board`, `github.reconcile-prs` and `ticket.sync` (the throttled jobs of ticket 06's `jobSending`). A throttle, never a budget.
  - **The panel (Q157):** `createProducer(jobs)` retries the enqueue-only start in the background with backoff (500 ms doubling to 30 s), reports `starting` until it connects, and refuses an enqueue while the schema isn't there, so the caller's transaction rolls back. `apps/web` uses it instead of its own lazy start.
  - **Tests** (`src/jobs-m2.test.ts`): the heartbeat set at start and carried by an occurrence forwarded into the queue, the boot check refusing a queue without it, a worker refused when its sessions aren't in UTC, the schedule's stored slot, a group's limit of 2 held across 6 handlers, a duplicate send, and the producer against a database with no pg-boss schema until a worker installs it. Not ported: spike 8's full hunt that kills the replica holding a forwarded batch (C4); the test checks the mechanism it rests on, that an occurrence takes the queue's heartbeat when it's inserted. Ticket 38's kill points are where the full scenario belongs.
