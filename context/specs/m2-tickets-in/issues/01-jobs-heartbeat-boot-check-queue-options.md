# 01: `packages/jobs`: the heartbeat, the boot check and the queue options

Status: ready-for-agent
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

- [ ] Tests: a replica killed while holding a forwarded batch doesn't strand it for 15 minutes, on the spike's scenario ported as a test; the boot check refuses a queue without its heartbeat; a schedule doesn't fire twice in its window; a group's limit holds for running handlers; a duplicate send returns the first job; the panel's producer starts after the schema appears.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `🐛 close the job queue's gaps from spike 8`.

## Comments
