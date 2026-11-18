# Background work on pg-boss, behind one package

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Settles Q24, and Q10, Q20 and Q78 where they touch the queue. It reverses the order in `research/durable-execution.md`: pg-boss first, DBOS Transact as the fallback. Covers F-043 to F-048 and F-106. It names the queue that ADR 0011 and ADR 0017 leave open.

pg-boss runs ostra's background work: webhooks, retries, timers, schedules and reconciliation. It's a new dependency (MIT). Every import of it sits in one package, `packages/jobs`.

**Three rules hold whichever library ships** (`research/durable-execution.md`):
1. **ostra's tables are the source of truth.** A task's discriminated union and its event log say where it stands. A job carries out one transition and checks the task's state again before it acts. If the queue were lost, the next reconciliation pass would rebuild the work from the tables.
2. **Jobs are short and carry only IDs.** Their keys are fixed by what they do, such as `task:<TaskId>:<transition>:<seq>` and `webhook:<provider>:<deliveryId>`. Sending a job twice returns the existing one.
3. **A human wait is a task state,** never a job blocked for hours. "Needs you" is a state. An answer writes the decision and enqueues the continuation in the same transaction. A delayed job handles the timeout: it wakes, checks the state, and does nothing if the task has moved on.

**What runs on it:**
- Webhook processing, with the delivery row and its job saved in one transaction (F-043, F-046).
- Reconciliation against the tracker and the code host, one keyed schedule per connected board and repo (F-044).
- Timers: a session's maximum duration, stall detection, the task grace after a runner is lost (ADR 0034), and cleanup after 14 days (F-079).
- Schedules on automations, created at runtime and stored in the database (F-106, Q10).
- Retries with backoff for every call to a tracker or code host (ADR 0011).
- Insights, computed every few minutes (F-108), and the daily refresh of the model catalog and each provider's model list (ADR 0033).

**How it's used:**
- A job is enqueued inside the Prisma 7 transaction with `{ db: fromPrisma(tx) }`, which needs `@prisma/adapter-pg`. So a job exists only if its transaction commits. The panel enqueues without running workers, and only the core service runs them (ADR 0016).
- pg-boss supplies what ostra would otherwise build:
  - heartbeats (switched on per queue) that free a dead replica's jobs, with no executor IDs to manage
  - dead-letter queues, and retention
  - schedules in the database, by cron or RRULE, with a key for several per queue, which send one job however many replicas run
  - a limit per group across replicas (`groupConcurrency`), which can briefly overshoot
  - an MIT dashboard, `@pg-boss/dashboard`, where authentication is ostra's own
- ostra builds, on top of it:
  - **Request budgets per credential** (Q20). Each adapter's base class keeps a budget row per credential in Postgres, fed by the response headers. A call that would overspend becomes a job delayed until the reset. No queue counts requests per hour.
  - **Task admission and runner scheduling** (F-067), from ostra's own tables, read with `FOR UPDATE SKIP LOCKED`.
  - **Idempotency toward trackers and the code host** (F-046): record the key before the call, or check first whether it already happened.
  - **A "Background work" page** built on the dashboard's data and ostra's tables: queues, stuck jobs, retry and cancel.
- **The seam.** `packages/jobs` is the only package that imports pg-boss, and a lint rule enforces it (Q78). It holds typed job definitions with Zod-checked payloads, an `enqueueInTx(tx, ...)` function and schedule management. A swap to DBOS, or a fork, stays bounded. If the package count slows the build, `jobs` folds into `domain` behind the same lint rule.

## Considered options

- **DBOS Transact first,** as `research/durable-execution.md` recommended. Rejected as the first choice:
  - Under the three rules above, its durable workflows have nothing left to do: ostra's tables hold the state, jobs are short, and a human wait is a state.
  - What remains of it needs a sweeper for a dead replica, retention and an admin view, all of which pg-boss already has.
  - DBOS keeps those same pieces, along with automatic upgrades of running workflows, in its proprietary Conductor or its paid extension. It moved the Conductor client out of the open package in October 2026. Its open-source upgrade route pins an application version and branches with patches, and its drift toward open core would land on self-hosters.
  - It stays the fallback.
- **graphile-worker.** Rejected: no rate limits and no concurrency per key above one, a static cron, and a crashed worker's jobs stay locked for four hours unless ostra builds its own heartbeat or buys Worker Pro.
- **Hatchet, Trigger.dev, Inngest, Restate and Temporal.** Rejected: each takes jobs over an API into a separate engine, so none can join ostra's transactions. Each also adds services, and two have licenses that don't fit a self-hosted install: Inngest's server is SSPL, and Restate's is BSL 1.1.
- **pgmq, Absurd and OpenWorkflow.** Rejected: each leaves more for ostra to build than pg-boss does.
- **Redis or a hosted queue.** Rejected: Postgres is the only store an install needs (ADR 0017).

## Consequences

- Multi-step work is an explicit state machine in ostra's tables, which ostra wants anyway, and waits for people are states.
- Installs upgrade on their own schedule (ADR 0022). A queue of small jobs that carry only IDs can't be stranded by an upgrade, which a versioned workflow can.
- pg-boss is maintained by one person, sponsored by Supabase and others, and its license is MIT "and always will be". The seam and the option to fork carry that risk.
- It needs Node 22.12 or later and Postgres 13 or later. Its optional `LISTEN/NOTIFY` doesn't work through a pooler in transaction mode, so an install behind one runs without it.
- Queue retention ships with pg-boss's own defaults, and its line goes in the configuration reference.
- Spike 8 (`durable-queue-choice`) gates it:
  - A job enqueued inside a Prisma 7 transaction exists only if the transaction commits.
  - After `kill -9` on one of two replicas mid-job, the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate side effect.
  - A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys, with any brief overshoot recorded.
  - 200 schedules created at runtime each fire once per tick while replicas restart.
  - Delayed jobs survive a restart and can be cancelled, and the panel process enqueues without running workers.
  - It compiles under ostra's strict flags.
- Revisit if spike 8 shows pg-boss can't hold a limit per key across replicas, or can't recover a killed replica's jobs without a duplicate side effect. Then the same scenarios run on DBOS.
- The load test at 1,000 tasks (F-117) covers the queue, and the failure suite (F-048) kills a replica mid-job.
