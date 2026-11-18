# Research: durable execution and queues on Postgres

**Status:** Research v1 · **Checked:** 2026-11-18 (every source below was read on this date unless marked) · **Informs:** ADR 0011, ADR 0017, ADR 0016, `build-order.md` milestone 0 spike 6, F-043–F-048, F-067, round-7 Q10 (schedules on intake rules), Q18 (scale target) and Q20 (rate limits)

Facts come from official docs, READMEs, license files, the GitHub REST API and the npm registry. **Unverified** marks anything not confirmed from a primary source. Recommendations are marked as such and are not decisions. `AGENTS.md` still applies: the maintainer approves any new dependency.

**Where the maturity numbers come from:**
- **Stars, license and last push:** `api.github.com/repos/<repo>`, read 2026-11-18. The API's unauthenticated quota ran out before the per-repo release lists could be read.
- **Release versions and dates:** the npm registry (`registry.npmjs.org/<pkg>`).
- **Weekly downloads:** `api.npmjs.org/downloads/point/last-week/<pkg>`.

---

## Summary

- **What ostra needs from a queue.** Postgres only (ADR 0017), shipped with one `docker compose up` (ADR 0001), with nothing ostra must license separately (ADR 0009). The one feature that rules most candidates out is **transactional enqueue**: writing a job in the same Postgres transaction as the change that caused it. Each of these lets ostra's own transaction write the job:
  - DBOS Transact
  - pg-boss
  - graphile-worker
  - pgmq
  - Absurd (by design; **unverified** from its docs)

  Hatchet, Trigger.dev, Inngest, Restate and Temporal all take jobs over an API into a separate engine, so ostra would have to build its own outbox and a relay to feed them.
- **Ruled out by license or weight:**
  - **Inngest's server** is SSPL. Each version becomes Apache-2.0 only three years after release ([LICENSE.md](https://github.com/inngest/inngest/blob/main/LICENSE.md)).
  - **Restate's server** is BSL 1.1, becoming Apache-2.0 after four years ([LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE)). It keeps its state in its own RocksDB and log, not in Postgres.
  - **Trigger.dev self-hosted** needs Redis, object storage, a container registry, a supervisor and access to the Docker socket. It has no checkpoints, so a run that waits for days holds its machine the whole time ([self-hosting overview](https://trigger.dev/docs/self-hosting/overview)).
  - **Temporal** has four server services, and needs an outbox to get transactional enqueue.
- **The real choice is between two Postgres-only libraries:**
  - **DBOS Transact.** A durable-execution library: workflows, steps, durable sleep, messages, queues with per-partition concurrency and rate limits, and schedules stored in the database. MIT, company-backed.
  - **pg-boss.** A mature job queue: global per-group concurrency, throttling and debouncing, heartbeats, dead-letter queues, cron and RRULE schedules, a Prisma transaction adapter and an MIT dashboard. One maintainer.

  graphile-worker is excellent and fast. But it has no rate limits and no per-key concurrency above 1, its cron is static, and a crashed worker's jobs stay locked for 4 hours unless ostra builds its own heartbeat or buys Worker Pro.
- **Recommendation: DBOS Transact (TypeScript) as the primary choice, with pg-boss as the named fallback.** Both get tried in milestone 0, spike 6. DBOS covers the most of ostra's list natively:
  - workflows in steps, durable sleep, and messages a workflow can wait on with a timeout
  - concurrency and rate limits per partition key, where a key can be a credential
  - priority and deduplication
  - schedules stored in the database, with backfill
  - enqueue from a SQL function, called inside ostra's own Prisma transaction
- **The biggest risk is open-core drift at DBOS.** The MIT core covers what ostra needs today. But these all live in the proprietary Conductor or the commercial "Enterprise extension":
  - automatic recovery of a dead replica's workflows
  - retention policies
  - the dashboard
  - automatic upgrades of workflow versions
  - sharding

  In October 2026 the Conductor client also moved out of the open-source package. ostra must build those parts itself, and keep workflows short so an upgrade never strands one.
- **Design rule, whichever library ships:**
  - ostra's own tables hold each task's state machine, its discriminated union and its event log. They are the source of truth.
  - Workflows and jobs are short, and their IDs are fixed by what they do.
  - A human wait of hours or days is a task state, plus a continuation job and a timeout job. It is never a workflow blocked for days.

  This keeps upgrades safe, and it keeps the library swappable.

---

## What ostra needs, mapped to primitives

| Workload | Primitive it needs | Notes |
|---|---|---|
| Webhook processing (F-043, F-046) | Transactional enqueue; deduplication by delivery ID | Save the delivery row and enqueue in one transaction ("save, then act", ADR 0011) |
| Linear and GitHub reconciliation (F-044) | Per-board and per-repo schedules created at runtime; one run at a time per key | "Within 5 minutes" (F-044) means one schedule per connected board or repo |
| Timers: a session's max duration, stall detection, cleanup after 14 days | Delayed jobs that can be cancelled or that check state on wake | Long delays must survive restarts and upgrades |
| Schedules on intake rules (round-7 Q10) | Cron created at runtime, stored in the database, exactly once across replicas | One schedule per rule |
| Per-provider and per-key limits (round-7 Q20) | Global concurrency per key; start-rate limits per key; waiting instead of failing | GitHub's and Linear's budgets count requests per hour, which no queue counts (see Recommendation) |
| Long waits for human approval (F-026) | A wait for an outside signal, with a timeout | Hours to days |
| Task orchestration: queued → preparing → running → needs you → in review | Multi-step, retried, idempotent side effects | Each task can be reopened later (ADR 0006), so its life has no fixed end |
| Several replicas over one Postgres (round-7 Q18) | Coordination through the database, and recovery of a dead replica's work | 1,000 concurrent tasks *(working value)* |
| Failure tests (F-048) | A process killed with `kill -9` leaves nothing lost and nothing duplicated | Spike scenario 2 |

---

## Comparison

### Infrastructure, license and maturity

| | Postgres only? | Extra process | License (server / SDK) | OK inside an AGPL install? | Stars | Latest TS release | npm/week |
|---|---|---|---|---|---|---|---|
| **DBOS Transact** | **Yes** (a library; its tables live in a `dbos` schema) | None. Conductor is optional and proprietary | MIT / MIT | Yes. Avoid Conductor and the Enterprise extension | 1,448 | `@dbos-inc/dbos-sdk` 5.6.0, 2026-11-17 | 849k |
| **pg-boss** | **Yes** (a library) | None. Dashboard and proxy are optional | MIT | Yes | 4,152 | 12.38.2, 2026-11-10 | 5.14M |
| **graphile-worker** | **Yes** (a library) | None | MIT. Worker Pro is proprietary | Yes. Avoid Pro | 2,450 | 0.18.0, 2026-09-08 | 1.26M |
| **Hatchet** | Yes. RabbitMQ is optional | **Go engine and API** (`hatchet-lite`), plus its own database | MIT / MIT | Yes | 8,303 | SDK 1.47.4, 2026-11-17 | 510k |
| **Trigger.dev** | **No**: Postgres, Redis, ClickHouse (recommended), s2-lite, object storage, a registry | Webapp, supervisor, and a container per run | Apache-2.0 | Yes, but very heavy | 16,778 | SDK 4.8.5, 2026-11-12 | 1.54M |
| **Inngest** | **No** for several nodes: Postgres plus Redis | Go server | **SSPL**, Apache-2.0 after 3 years / SDK Apache-2.0 | **No**: SSPL | 6,052 | SDK 4.26.2, 2026-10-29 | 1.96M |
| **Restate** | **No**: its own RocksDB and log; object storage for clusters | Rust server | **BSL 1.1**, Apache-2.0 after 4 years / SDK MIT | **No** (not open source; grey area) | 4,708 | SDK 1.18.4, 2026-11-17 | 449k |
| **Temporal** | Postgres can be its store | **4 services** (frontend, history, matching, worker) plus the UI | MIT / MIT | Yes, but heavy | 24,462 (server) | `@temporalio/worker` 1.26.0, 2026-11-17 | 6.05M |
| **pgmq** | Yes (extension or plain SQL) | None | PostgreSQL license | Yes | 5,400 | community `pgmq-js` 1.3.1, 2026-02-19 | 113 |
| **Absurd** | **Yes** (one SQL file) | None (optional Go UI, "habitat") | Apache-2.0 | Yes | 2,560 | `absurd-sdk` 0.5.1, 2026-10-20 | 21k |
| **OpenWorkflow** | Yes (or SQLite) | None | Apache-2.0 | Yes | 1,350 | 0.11.0, 2026-10-12 | 17k |
| **Vercel Workflow + Postgres World** | Yes (built on graphile-worker) | None, but calls back through HTTP routes in the app | Apache-2.0 | Yes | n/a | `@workflow/world-postgres` 5.3.0, 2026-11-17 | 426k |

### Features against ostra's workloads

| | Transactional enqueue | Durable steps | Sleep / timers | Wait for an outside signal (days) | Idempotency | Retries and backoff | Delivery | Concurrency per key | Rate limit per key | Cron | Several replicas | UI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **DBOS** | **Yes**: `enqueueInTransaction(pgClient)`, or the `dbos.enqueue_workflow` / `dbos.send_message` SQL functions | Yes | `DBOS.sleep`, `delaySeconds` | `DBOS.recv(topic, timeout)` | Workflow ID; `deduplicationID` | Per step: `maxAttempts`, `intervalSeconds`, `backoffRate` | Workflow once per ID; steps at least once; transactions exactly once | **Yes**: `partitionConcurrency`, global and per process | **Yes**, on starts: `partitionRateLimit` | **Yes**: runtime, in the database, backfill | Yes. A dead replica needs Conductor or ostra's own sweeper | Conductor only (proprietary) |
| **pg-boss** | **Yes**: `db` option; `fromPrisma(tx)` | No (only dependency flows) | `startAfter` | No: model it as state plus a job | `singletonKey`, `id`, policies | `retryLimit`, `retryDelay`, `retryBackoff`, `retryDelayMax` | At least once; transactional workers | **Yes**: `groupConcurrency`, global | Throttling by time slot only | **Yes**: cron and RRULE in the database, with keys | **Yes**: heartbeats, any instance | `@pg-boss/dashboard` |
| **graphile-worker** | **Yes**: `add_job` SQL | No | `run_at` | No | `job_key` with modes | Exponential, 25 attempts by default | At least once | Only 1, through `queue_name` | No | Static crontab only | Yes, but a crashed worker's jobs stay locked **4 h** | None |
| **Hatchet** | No (gRPC or REST) | Durable tasks | `sleepFor` | Durable event waits | Yes (**unverified** detail) | Yes | At least once; durable tasks checkpointed | **Yes**: CEL keys, round-robin | **Yes**: dynamic, with units | Yes, created at runtime | Yes | **Yes**, MIT dashboard |
| **Trigger.dev** | No | Yes | `wait.for` / `until` | `wait.forToken` (holds its machine when self-hosted) | `idempotencyKey` and TTL | Yes | At least once | `concurrencyKey` | **Unverified** | Yes | Worker machines | Yes |
| **Inngest** | No | `step.run` | `step.sleep` | `step.waitForEvent` | Yes | Yes | Steps memoized, at least once | Yes | Yes, plus throttling | Yes | Needs Redis | Yes |
| **Restate** | No | `ctx.run` | `ctx.sleep` | Awakeables and workflow promises | Idempotency keys | Yes | Journaled | Virtual objects (one writer per key); flow-control keys | **Unverified** | **Unverified** | Cluster of 3 or more nodes | Yes (**not checked**) |
| **Temporal** | No | Activities | Timers | Signals and updates | Workflow ID | Yes | Activities at least once | Fairness keys | Yes, per fairness key | Schedules | Yes | Yes |
| **pgmq** | Yes (`pgmq.send` in SQL) | No | Delay | No | No | No: a visibility timeout | Once per visibility timeout | No | No | No | Yes | No |
| **Absurd** | Yes (stored procedures; **unverified**) | Yes | Yes | `awaitEvent` (events cached; first emit wins) | Derived from the task ID | Yes | Steps checkpointed | **Unverified** | **Unverified** | **Unverified** | Pull workers | habitat |
| **OpenWorkflow** | **Unverified** | Yes | Yes | Signals | Yes | Yes | Steps checkpointed | Per worker only (per key planned) | Not listed | Yes | **Unverified** | Dashboard (CLI) |

---

## Candidates

### DBOS Transact (TypeScript)

**What it is.** A durable-execution library that runs inside your own process. It saves each workflow's inputs and each step's output to Postgres. When a process restarts, the library finds unfinished workflows and resumes each from its last completed step. Repo: [dbos-inc/dbos-transact-ts](https://github.com/dbos-inc/dbos-transact-ts), MIT, 1,448★, pushed 2026-11-17. npm `@dbos-inc/dbos-sdk` 5.6.0 (2026-11-17), 849k downloads a week, majors 4.0 (2025-09-30) and 5.0 (2026-09-16). DBOS, Inc. (Cambridge, MA) raised an $8.5M seed in 2024 according to a company-data aggregator (**unverified**).

**Postgres only.** Yes. Its tables live in a configurable schema (`systemDatabaseSchemaName`, default `dbos`). They can sit in their own database or alongside the app's tables. The Go docs describe the shared setup, where "your application tables live in the same database that hosts the DBOS system schema" ([config reference](https://docs.dbos.dev/typescript/reference/configuration), [Go transactions](https://docs.dbos.dev/golang/tutorials/transaction-tutorial)). Each process uses a pool of 10 connections by default (`systemDatabasePoolSize`), or takes a `node-postgres` pool you pass in (`systemDatabasePool`).

**License and the AGPL.** The core is MIT, so it bundles cleanly. Two parts are not open source:
- **Conductor**, its management and recovery service, is "released under a proprietary license". A production license "is required" from sales, and it phones home to `cloud.dbos.dev` to check that license ([self-hosting Conductor](https://docs.dbos.dev/conductor/self-hosting/hosting-conductor)).
- **The Enterprise extension** is "a commercial extension … available on all paid plans". It holds automatic workflow version upgrades and sharded Postgres. Also, "we moved the DBOS Conductor client into a separate Enterprise package" ([October 2026 update](https://www.dbos.dev/blog/whats-new-in-dbos-october-2026)).

ostra must use neither: a self-hoster would need a DBOS contract.

**Weight.** One npm package. Migrations run on launch by default (`runMigrations: true`). No extra container.

**TypeScript and types.** Written in TypeScript:
- `DBOS.registerWorkflow(fn)` returns a function with the same signature.
- Queues and topics are named by strings.
- `DBOS.recv<T>()` is an unchecked generic, so ostra parses what it receives with Zod (`AGENTS.md`: stored data is external data).
- Values are serialized with SuperJSON ([FAQ](https://docs.dbos.dev/faq)). A workflow enqueued from SQL must use "portable" JSON serialization ([cross-language](https://docs.dbos.dev/explanations/portable-workflows)).

**Durable workflows** ([workflow tutorial](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial), [steps](https://docs.dbos.dev/typescript/tutorials/step-tutorial), [communication](https://docs.dbos.dev/typescript/tutorials/workflow-communication)):
- **Steps.** A step is "tried at least once" and is never run again once it completes. Retries are set per step: `retriesAllowed` (default false), `intervalSeconds` (1), `maxAttempts` (3) and `backoffRate` (2).
- **Determinism.** A workflow must call the same steps in the same order. Breaking this throws `DBOSStepNondeterminismError`.
- **Sleep.** `DBOS.sleep` is durable, with no stated maximum ("days, weeks, or months").
- **Messages.** `DBOS.send` and `DBOS.recv(topic, timeoutSeconds)` deliver a message to a running workflow. The default timeout is 60 s and can be set longer. A message can be sent from outside, through `DBOSClient` or the `dbos.send_message` SQL function. `setEvent` and `getEvent` publish values back out.
- **Idempotency.** The workflow ID is the idempotency key: starting a workflow with a used ID returns the existing one.
- **Timeouts and dead letters.** A timeout (`timeoutMS`) cancels the workflow and its children. A workflow that crashes its process too often reaches `MAX_RECOVERY_ATTEMPTS_EXCEEDED`, which acts as a dead-letter state ([Java reference](https://docs.dbos.dev/java/reference/workflows-steps), [CLI](https://docs.dbos.dev/typescript/reference/cli)).
- **Database transactions.** `@dbos-inc/prisma-datasource` (Knex, Kysely, Drizzle, TypeORM, node-postgres and Postgres.js have one each) runs a transaction that "atomically commit[s] both user-defined changes and a DBOS checkpoint", "ensuring that each transaction is run exactly once" ([transactions](https://docs.dbos.dev/typescript/tutorials/transaction-tutorial)).

**Queues, concurrency and rate limits** ([queue tutorial](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)):
- **Concurrency:** `workerConcurrency` (per process) and `globalConcurrency` (across processes).
- **Rate limit:** `rateLimit: { limitPerPeriod, periodSec }`, which counts workflows *started* per period, globally.
- **Partitioned queues:** `partitionConcurrency`, `partitionWorkerConcurrency` and `partitionRateLimit`. Every enqueue passes a `queuePartitionKey`. This is the per-key limit ostra needs: the partition key can be a credential ID.
- **Deduplication:** a `deduplicationID` lets only one matching workflow be active. A duplicate throws, or returns the existing handle with `duplicationPolicy: 'return-existing'`.
- **Scheduling within the queue:** `priority`, `delaySeconds` and `DBOS.setWorkflowDelay`.
- **Changing limits at runtime:** `retrieveQueue().setRateLimit(...)`.
- **Choosing workers:** `listenQueues` picks which queues a process takes work from.

**Transactional enqueue.** Yes, two ways:
- `DBOSClient.enqueueInTransaction(client, …)` takes "a `node-postgres` Client or PoolClient with an open transaction" ([client reference](https://docs.dbos.dev/typescript/reference/client)).
- The `dbos.enqueue_workflow` SQL function lets you "enqueue workflows as part of a broader database transaction" ([April 2026 update](https://www.dbos.dev/blog/dbos-new-features-april-2026), [blog](https://www.dbos.dev/blog/running-durable-workflows-from-postgres-udfs)).

With Prisma, the SQL function can be called through `tx.$executeRaw` inside `prisma.$transaction`, if DBOS's schema is in the same database (**to verify in the spike**). The Next.js process never needs to launch DBOS: it only enqueues.

**Schedules** ([scheduled workflows](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows)):
- `DBOS.createSchedule` creates a schedule at runtime. Schedules "can be created, paused, resumed, and deleted at runtime" and "are stored in the database".
- "Each time a schedule fires, its workflow is executed by exactly one worker process".
- Missed runs can be backfilled, with `DBOS.backfillSchedule` or `automaticBackfill: true`.

One schedule per intake rule, and one per board's reconciliation, fits.

**Scaling across replicas:**
- Processes share queues through `FOR UPDATE SKIP LOCKED` ([making Postgres queues scale](https://www.dbos.dev/blog/making-postgres-queues-scale)). DBOS measured 43K workflows/s started directly, and 30.6K/s through queues, on one Postgres server ([benchmark](https://www.dbos.dev/blog/benchmarking-workflow-execution-scalability-on-postgres)). That is orders of magnitude above ostra's target.
- **The catch is a replica that dies for good.** "When self-hosting in a distributed setting without Conductor", each process needs a "unique, stable executor ID", and a process restarted with that ID recovers only its own work. For an executor "gone for good", another process calls `DBOS.recoverWorkflows(["executor-1"])`. "Only recover executors you know have stopped": recovering a live one can run steps twice ([workflow recovery](https://docs.dbos.dev/production/workflow-recovery)). Conductor automates this, after 60 s by default ([distributed recovery](https://docs.dbos.dev/conductor/distributed-recovery)).
- Since October 2026, each execution holds an ownership token, so a stale "zombie" process can no longer overwrite a workflow's checkpoints ([October 2026 update](https://www.dbos.dev/blog/whats-new-in-dbos-october-2026)).

**Upgrades** ([upgrading workflows](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)):
- By default the application version is "a hash of workflow source code". Recovery "only picks up workflows whose version matches".
- The open-source route is to pin `applicationVersion` and branch with `DBOS.patch('name')` and `DBOS.deprecatePatch`.
- Moving old workflows onto new code automatically is "a DBOS Transact Enterprise feature".

For a product that each team upgrades on its own schedule (ADR 0022), this decides how long a workflow may live.

**Observability:**
- OpenTelemetry traces and logs (`enableOTLP`, `tracingEnabled`), plus a CLI (`npx dbos workflow list|resume|fork`).
- Workflow listing APIs exist. Retention policies and the dashboard are Conductor features ([retention](https://docs.dbos.dev/conductor/retention)). Without Conductor, ostra deletes old history itself (which open-source API does this is **unverified**).
- DBOS's production checklist sizes Postgres at 4 vCPUs per 1,000 actions a second ([checklist](https://docs.dbos.dev/production/checklist)).

**Fit.** The best native fit for ostra's list:
- transactional enqueue from SQL
- concurrency and start-rate limits per credential
- priority and deduplication
- runtime schedules with exactly-once firing
- durable sleep and waits with timeouts
- exactly-once database steps

Costs: ostra builds dead-replica recovery, retention and admin views itself, and keeps workflows short because of versioning.

### pg-boss

**What it is.** A job queue in Postgres for Node. Repo: [timgit/pg-boss](https://github.com/timgit/pg-boss), MIT, 4,152★, written in TypeScript, pushed 2026-11-17. npm 12.38.2 (2026-11-10), 5.14M downloads a week, the most of any candidate here, and maintained since 2016. Major versions: 10.0 (2024-08), 11.0 (2025-09), 12.0 (2025-11). "It is maintained by one person" ([README](https://github.com/timgit/pg-boss/blob/master/README.md)). It needs Node 22.12+ or Bun, and Postgres 13+.

**Postgres only.** Yes, with no other process. An optional dashboard and an HTTP proxy are separate packages.

**TypeScript.** Written in TypeScript. Typing of job data is generic per call (**unverified** detail). ostra would validate it with Zod.

**Jobs and retries** ([queues](https://pgboss.io/api/queues), [jobs](https://pgboss.io/api/jobs)):
- **Retries:** `retryLimit` (default 2), `retryDelay`, `retryBackoff` (exponential) and `retryDelayMax`.
- **Crashed workers:** `expireInSeconds` (default 15 min). `heartbeatSeconds` (opt-in, at least 10 s) "detects crashed workers much faster than expiration". The page warns that a worker that only *seems* dead may still finish, so handlers must be idempotent.
- **Dead letters:** `deadLetter` queues, with redrive.
- **Retention:** `retentionSeconds` (default 14 days) and `deleteAfterSeconds` (default 7 days).

**Queue policies:**
- `standard`
- `short` (one queued)
- `singleton` (one active)
- `stately`
- `exclusive`
- `key_strict_fifo` (FIFO per `singletonKey`; a key blocks while it fails)

**Deferral, throttling and flows:**
- Deferral: `startAfter`.
- Throttling and debouncing: `singletonSeconds`, `singletonNextSlot`, `sendThrottled()` and `sendDebounced()`.
- Flows: `flow(jobs)` creates a dependency graph of jobs in one transaction.
- **No durable steps, and no waiting for an outside signal**: a wait is modelled as state plus a later job.

**Concurrency** ([workers](https://pgboss.io/api/workers)):
- `groupConcurrency` limits jobs that share a `group` id "globally across all nodes", "enforced via database queries". Concurrent fetches "can briefly exceed the limit".
- `localConcurrency` is per node.
- There's **no rate limit per unit of time** beyond throttling by time slot.
- LISTEN/NOTIFY is opt-in and doesn't work through PgBouncer in transaction mode.

**Transactional enqueue.** Yes. Pass `{ db: fromPrisma(tx) }` inside `prisma.$transaction`, which "requires Prisma v7+ with `@prisma/adapter-pg`". Drizzle, Knex and Kysely have adapters too. *Transactional workers* commit a worker's writes together with the job's completion ([adapters](https://pgboss.io/api/adapters)).

**Schedules** ([scheduling](https://pgboss.io/api/scheduling)):
- Cron or RRULE, stored in a table.
- A `key` allows several schedules per queue.
- Checked every 30 s, and "only 1 job is sent even if multiple instances are running".
- Instances correct for clock skew against the database.

**Scaling across replicas.** "Multi-master compatible (for example, in a Kubernetes ReplicaSet)". With heartbeats on, no executor IDs are needed.

**UI.** [`@pg-boss/dashboard`](https://pgboss.io/dashboard) runs standalone or as an embeddable Fetch handler: "Authentication is yours". It can be read-only. OpenTelemetry traces and metrics are supported.

**Fit.** Strong on queue mechanics, operations and maturity, and the lowest risk of a vendor changing course (MIT, "and always will be"). ostra would build:
- every multi-step orchestration, as an explicit state machine (which ostra wants anyway)
- start-rate limits per key
- waits for human signals

The single maintainer is its bus factor.

### graphile-worker

**What it is.** A job queue for Postgres and Node from Graphile, the PostGraphile authors, funded by sponsors. Repo: [graphile/worker](https://github.com/graphile/worker), MIT, 2,450★, pushed 2026-11-05. npm 0.18.0 (2026-09-08), 1.26M downloads a week, still 0.x after 7 years. Vercel's Workflow Postgres World switched from pg-boss to it ([commit](https://github.com/vercel/workflow/commit/1f9a67c759fa6444f6f652692871e8bc7e65ea71)).

**Jobs** ([add_job](https://worker.graphile.org/docs/sql-add-job)):
- `add_job` is a SQL function, so it runs in your own transaction. It "requires database owner privileges", or a `SECURITY DEFINER` wrapper.
- Options: `job_key` with `replace`, `preserve_run_at` or `unsafe_dedupe` modes, `run_at`, `priority`, `max_attempts` (default 25) and `flags`.
- `queue_name` runs one job at a time per queue, and the docs warn against high-cardinality names.
- **No rate limits, and no per-key concurrency above 1.**

**Performance** ([performance](https://worker.graphile.org/docs/performance)). About 196k jobs/s with batching, about 15.6k/s without, and under 5 ms latency through LISTEN/NOTIFY.

**Cron** ([cron](https://worker.graphile.org/docs/cron)). Comes from a crontab file or library config, and is exactly once through a `known_crontabs` table, with `fill` backfill. Adding schedules at runtime isn't documented, so one schedule per intake rule would be ostra's own code.

**Crashes.** A worker killed hard leaves its jobs "locked for at least 4 hours" ([error handling](https://worker.graphile.org/docs/error-handling)). The fixes:
- the paid, proprietary **Worker Pro** (USD $100/mo), with heartbeats ([Pro](https://worker.graphile.org/docs/pro), [recovery](https://worker.graphile.org/docs/pro/recovery))
- or ostra's own heartbeat, calling "force unlock workers" ([admin functions](https://worker.graphile.org/docs/admin-functions))

**TypeScript.** Payloads are `unknown` by default. Assertion functions are recommended, and `GraphileWorker.Tasks` declaration merging is an option ([TypeScript](https://worker.graphile.org/docs/typescript)).

**UI.** None. There's a stable `graphile_worker.jobs` view ([jobs view](https://worker.graphile.org/docs/jobs-view)).

**Fit.** A good bare queue. It is missing three of ostra's needs (per-key limits, runtime cron, quick crash recovery), and ostra would build all three.

### Hatchet

**What it is.** A task and workflow engine in Go on Postgres, with SDKs in TypeScript, Python, Go and Ruby. Repo: [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet), MIT, 8,303★, pushed 2026-11-17. TS SDK 1.47.4 (2026-11-17), 510k downloads a week. Hatchet Technologies is YC-backed; its pre-seed and seed rounds are **unverified** from a primary source.

**Infrastructure** ([self-hosting](https://docs.hatchet.run/self-hosting), [configuration](https://docs.hatchet.run/self-hosting/configuration-options)):
- PostgreSQL is required. RabbitMQ is optional: `SERVER_MSGQUEUE_KIND=postgres`.
- Hatchet Lite is a single image with the engine and the API, "suited to development, testing, or low-throughput production".
- Helm charts are the production route.
- An "embedded mode" runs the engine as a sidecar for development and CI ([embedded](https://docs.hatchet.run/v1/embedded)).
- Workers connect to the engine over gRPC with an API token. A fresh install has to mint that token for ostra's own workers (setup step **unverified**).

**Features:**
- **Durable tasks** checkpoint sleeps, event waits and child runs, and "don't hold a worker slot during waits". Code between checkpoints "must be deterministic" ([durable tasks](https://docs.hatchet.run/v1/durable-tasks)).
- **Concurrency** by CEL key, with `GROUP_ROUND_ROBIN`, `CANCEL_IN_PROGRESS` and `CANCEL_NEWEST`, at several levels ([concurrency](https://docs.hatchet.run/v1/concurrency)).
- **Rate limits**, static or dynamic per key, with units per run. A limited task is re-queued "until the rate limit is no longer exceeded" ([rate limits](https://docs.hatchet.run/v1/rate-limits)). This is the best rate-limit model of any candidate.
- **Cron** created at runtime through the API ([cron runs](https://docs.hatchet.run/v1/cron-runs)).
- **A full MIT dashboard**, plus Prometheus metrics.

**Transactional enqueue.** No. Jobs go through the engine's API, so ostra would need its own outbox table and a relay. That gives up the reason ADR 0017 put the queue in Postgres. Hatchet's founders have discussed the trade-off ([HN thread](https://news.ycombinator.com/item?id=39643136)).

**Fit.** A good feature fit, but it adds a second server (Go, with its own database and auth), and it can't join ostra's transactions. Not recommended. Revisit only if rate-limit needs outgrow what ostra builds.

### Trigger.dev

**What it is.** A TypeScript platform for background tasks and AI workflows. Tasks are built into images and run in separate containers. Repo: [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev), Apache-2.0, 16,778★. SDK 4.8.5 (2026-11-12).

**Self-hosting** ([Docker](https://trigger.dev/docs/self-hosting/docker), [overview](https://trigger.dev/docs/self-hosting/overview)):
- **Services:** the webapp, Postgres, Redis, ClickHouse (recommended for production), s2-lite for streams, object storage, a container registry, a supervisor on each worker machine, and a Docker socket proxy.
- **Machines:** a 3 vCPU / 6 GB webapp machine and a 4 vCPU / 8 GB worker machine at minimum.
- **No checkpoints:** "Checkpoints (non-blocking waits), so long waits use more resources" ([blog](https://trigger.dev/blog/self-hosting-trigger-dev-v4-docker)).
- **Telemetry:** on by default, which conflicts with ADR 0021.

**Features.** Waitpoint tokens for human input (`wait.createToken`, `wait.forToken`), with idempotency keys and TTLs ([wait for token](https://trigger.dev/docs/wait-for-token)). Also queues with `concurrencyKey`, schedules and a dashboard.

**Transactional enqueue.** No.

**Fit.** Poor. It's a platform that wants to own deployment and run ostra's code in its containers. Its self-hosted waits hold compute for days, and it adds four or more services to ostra's compose file.

### Inngest (self-hosted)

**What it is.** An event-driven durable-function platform. The server calls your functions over HTTP, or workers connect to it. Repo: [inngest/inngest](https://github.com/inngest/inngest), 6,052★. SDK `inngest` 4.26.2 (2026-10-29), 1.96M downloads a week.

**License.** "The Inngest server and CLI are available under the Server Side Public License and delayed open source publication (DOSP) under Apache 2.0". The license grants Apache-2.0 "on the third anniversary of the date we make the Software available" ([README](https://github.com/inngest/inngest#license), [LICENSE.md](https://github.com/inngest/inngest/blob/main/LICENSE.md)). The SDKs are Apache-2.0. Shipping an SSPL server inside an AGPL product, which ostra will also sell as hosting (ADR 0001), runs straight into SSPL section 13. **Disqualifying.**

**Infrastructure.** A single binary. It defaults to SQLite and an in-memory Redis. Postgres needs a server reached by `postgres-uri`, and SQLite "does not support scaling beyond a single node" ([self-hosting](https://www.inngest.com/docs/self-hosting)). Several nodes in practice need an external Redis (**unverified**: inferred from the docs).

**Features.** The richest flow control of all the candidates: concurrency per key, throttling, rate limits, debounce, singleton, priority and batching ([flow control](https://www.inngest.com/docs/guides/flow-control)). `step.waitForEvent` can take a timeout of days, with typed Zod event schemas ([waitForEvent](https://www.inngest.com/docs/reference/functions/step-wait-for-event)). Key-queue scheduling for many tenants "requires Enterprise access on request".

**Transactional enqueue.** No: events go over HTTP.

**Fit.** Ruled out by its license and its extra Redis.

### Restate

**What it is.** A durable-execution server in Rust, with its own replicated log ("Bifrost") and RocksDB partition stores. Services are HTTP handlers that the server calls. Repo: [restatedev/restate](https://github.com/restatedev/restate), 4,708★. TS SDK 1.18.4 (2026-11-17), MIT ([TS SDK](https://docs.restate.dev/develop/ts/overview)).

**License.** BSL 1.1. Its "Additional Use Grant" forbids a "Public Restate Platform Service", and each version becomes Apache-2.0 "4 years after release" ([LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE)). It is not open source. ostra's own use probably falls inside the grant, but the license would still put a non-OSI part in an install that is otherwise open source.

**Infrastructure.** A persistent volume. For clusters, also an object store for snapshots ([server overview](https://docs.restate.dev/server/overview), [snapshots](https://docs.restate.dev/server/snapshots)). **No Postgres at all**, so a second store to back up, which breaks ADR 0017's "one backup covers everything".

**Features.**
- Awakeables, durable promises, `ctx.sleep` and `ctx.run` ([concurrency](https://docs.restate.dev/develop/ts/concurrent-tasks)).
- Virtual objects, which run one writer per key.
- Idempotency keys and flow-control limit keys ([service communication](https://docs.restate.dev/develop/java/service-communication)).

**Fit.** Ruled out by its storage model and license.

### Temporal

**What it is.** The reference durable-execution platform. Server: [temporalio/temporal](https://github.com/temporalio/temporal), MIT, 24,462★. TS SDK: [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript), MIT, `@temporalio/worker` 1.26.0 (2026-11-17), 6.05M downloads a week.

**Infrastructure:**
- Frontend, history, matching and worker services. A real deployment example runs "5 Frontend, 15 History, 17 Matching, and 3 Worker Services", and production advice is to run each separately ([Temporal Server](https://docs.temporal.io/temporal-service/temporal-server)).
- PostgreSQL 12+ works for both persistence and advanced visibility from server 1.20 ([persistence](https://docs.temporal.io/self-hosted-guide/persistence)).
- A web UI container on top.

**Features:**
- Signals, updates, timers, schedules, child workflows and versioning ([TS developer guide](https://docs.temporal.io/develop/typescript/core-application)).
- TS workflows run in a deterministic sandbox (V8 isolate, **not re-checked** this session).
- Task-queue fairness keys with per-key rate limits (`fairness-key-rps-limit-default`) ([priority and fairness](https://docs.temporal.io/develop/task-queue-priority-fairness)).

**Transactional enqueue.** No (gRPC), so it needs an outbox.

**Fit.** Strong in features, the most mature, and MIT. But it's far too heavy for a self-hosted install with one `docker compose up`, and it can't join ostra's transactions.

### Newer and smaller options

- **pgmq** ([pgmq/pgmq](https://github.com/pgmq/pgmq), PostgreSQL license, 5,400★).
  - An SQS-style queue, installed as an extension or as plain SQL, with "exactly once" delivery "within a visibility timeout" and FIFO group keys ([README](https://github.com/pgmq/pgmq/blob/main/pgmq-extension/README.md)).
  - No retry policy, cron, rate limits or workflows. The TS clients are community projects (`pgmq-js`, 113 downloads a week).
  - A primitive to build on, not a solution.
- **Absurd** ([earendil-works/absurd](https://github.com/earendil-works/absurd), Apache-2.0, 2,560★, created 2025-10).
  - Armin Ronacher's durable execution in one SQL file of stored procedures, with thin TypeScript, Python and Go SDKs: steps as checkpoints, sleep, `awaitEvent` ("first emit wins"), retries, and a Go UI called habitat ([README](https://github.com/earendil-works/absurd/blob/main/README.md)).
  - "Does not try to match the breadth of a full workflow platform" ([comparison](https://earendil-works.github.io/absurd/comparison/)). Per-key limits and cron aren't documented.
  - `absurd-sdk` is 0.5.1. Its small footprint is attractive, but it's too young to rest the core on. Worth watching as a fallback that ostra could vendor.
- **OpenWorkflow** ([openworkflowdev/openworkflow](https://github.com/openworkflowdev/openworkflow), Apache-2.0, 1,350★, 0.11.0).
  - TS-native workflows on Postgres or SQLite.
  - Shipped: signals, sleep, idempotency keys, cron and a dashboard. "Workflow priority and concurrency controls" are still planned ([roadmap](https://openworkflow.dev/docs/roadmap)).
  - Too young.
- **Vercel Workflow DevKit with the Postgres World** (`workflow` 5.6.1; `@workflow/world-postgres` 5.3.0, Apache-2.0).
  - "This is a reference implementation… It is not a managed backend: it ships **without authentication**". It drives execution through HTTP routes in the app that by default anyone can reach ([README](https://github.com/vercel/workflow/blob/main/packages/world-postgres/README.md)).
  - Not suitable.
- **Effect Workflow** (`@effect/workflow` 0.19.1, MIT).
  - Lives under `effect/unstable/workflow` in the Effect 4 betas. A public reproduction reports that in-progress workflows don't resume after a restart ([repro](https://github.com/milanterhes/effect-cluster-workflow-restart/blob/main/README.md), **unverified** whether it's fixed).
  - It would also commit ostra to the Effect ecosystem. Not now.
- **Microsoft pg_durable.** A Postgres extension: a SQL DSL run by a background worker inside the database ([repo](https://github.com/microsoft/pg_durable), [InfoQ](https://www.infoq.com/news/2026/06/postgresql-pg-durable)). It needs a Postgres where extensions and background workers can be installed, and its workflows are SQL, not TypeScript. Doesn't fit.
- **Sidequest** (`sidequest` 1.17.0) is LGPL-3.0, with 3k downloads a week. **River** and **Oban** aren't TypeScript. **BullMQ** needs Redis. All out.

---

## Recommendation

*(Recommendation, for the maintainer to approve under `AGENTS.md`'s rule on dependencies. Not a decision.)*

**Use DBOS Transact (TypeScript)** for ostra's durable queue and workflows. Use only the MIT core: no Conductor, no Enterprise extension. **Keep pg-boss as the fallback**, and try both in milestone 0, spike 6. **Don't use** Hatchet, Trigger.dev, Inngest, Restate or Temporal: each adds a server, or a license problem, or both, and none can join ostra's transactions. graphile-worker, Absurd, OpenWorkflow and pgmq are reasonable building blocks, but each leaves more for ostra to build than DBOS or pg-boss.

Why DBOS ahead of pg-boss:
- **Partitioned queues** give per-credential concurrency caps and start-rate limits, globally, in the database.
- **Messages with timeouts and durable sleep** cover the waits for runner acknowledgements and the timers.
- **Exactly-once database steps** through the Prisma datasource.
- **Runtime schedules that fire exactly once, with backfill.**
- **SQL enqueue inside ostra's own transaction.**

pg-boss matches DBOS on transactional enqueue, schedules and operations. But ostra would write every multi-step orchestration and every rate limit itself.

**How ostra uses it (rules for the architecture ADR):**

1. **ostra's tables are the source of truth for a task.** The task's discriminated union and its event log (ADR 0011) say where a task stands. A workflow carries out one transition (prepare the workspace, start the session, open the PR, sync the ticket), and it re-checks the task's state before acting. If the library were swapped out, or a workflow lost, the next reconciliation pass would rebuild the work from the tables.
2. **Workflows are short, and their IDs are fixed by what they do:** `task:<TaskId>:<transition>:<seq>`, and `webhook:<provider>:<deliveryId>`. Re-sending a webhook, or retrying an API call, returns the existing workflow.
3. **Human waits are state, not blocked workflows.** "Needs you" is a task state. Approving writes the decision and enqueues the continuation in one transaction (`dbos.enqueue_workflow` from the Prisma transaction). A delayed workflow handles the timeout: it wakes, checks the state, and does nothing if the task has moved on. `DBOS.recv` is kept for waits of minutes, such as a runner acknowledging. This keeps workflows alive across few upgrades. A team that upgrades while 40 tasks wait for approval strands nothing.
4. **Pin `applicationVersion`** to a version of ostra's workflow contract, not the default source hash, and use `DBOS.patch` when a workflow's steps change. Otherwise every upgrade leaves `PENDING` work that only the old build would recover. The release notes say when the contract changes (ADR 0022).

**What ostra still builds:**

| Piece | Why the library doesn't cover it |
|---|---|
| **Replica membership and dead-replica recovery** | The core service needs a table of live replicas anyway, to know which one holds each runner's connection (ADR 0016). A sweeper marks a replica dead after N missed heartbeats and calls `DBOS.recoverWorkflows([executorId])`. The library only automates this in proprietary Conductor. Steps are idempotent anyway (ADR 0011 #4), so a false positive costs a repeated call, never a duplicate side effect |
| **Request budgets per provider and per key** | DBOS limits workflow *starts*. GitHub (about 5k–12.5k req/h) and Linear (5k req/h) count *requests*, and one workflow makes many. ostra keeps a budget row per credential in Postgres, updated from each response's rate-limit headers (`research/platform-auth-github.md`, `research/trackers.md`). A step that would overspend sleeps until the reset, so tasks wait instead of failing (round-7 Q20). Partitioned queues keyed by credential stay as the coarse cap |
| **Task admission and runner scheduling (F-067)** | Matching queued tasks to runner slots, labels and pools, ordered by ticket priority, and visible and cancellable by admins, is product logic. It's ostra's own tables, read with `FOR UPDATE SKIP LOCKED`. Concurrency caps per Anthropic key (sessions at once) live here, because the sessions run on runners, not in the core service |
| **Idempotency toward GitHub and Linear (F-046)** | No library can make an outside call idempotent. ostra records the key or outcome of each call before making it, or checks first ("does this PR already exist?"), inside steps |
| **Reconciliation (F-044)** | One DBOS schedule per connected board and repo, created and removed with the connection. The diffing logic is ostra's |
| **Retention** | DBOS's retention policies are a Conductor feature. ostra runs its own scheduled cleanup of completed workflow history, beside F-079's cleanup |
| **Admin views** | A "Background work" panel page built on DBOS's listing APIs and on ostra's tables: queues, stuck workflows, retrying and cancelling. No Conductor console |
| **A thin seam** | One package (`packages/jobs`, name to be decided) owns every DBOS import: typed workflow definitions with Zod-validated inputs, `enqueueInTx(tx, …)` and schedule management. This keeps the strict-typing rules in one place, and leaves a swap to pg-boss or a fork of the MIT core bounded |

**Spike it in milestone 0: yes.** It's already spike 6. Run the scenarios below on DBOS. Then spend half a day on pg-boss for scenarios 1, 2, 4 and 5, so the comparison rests on measurements. Bring the result to the maintainer before adding the dependency.

---

## Unknowns / spike

**Spike 6 scenarios** (throwaway code in `spikes/durable-queue-choice/`). Each one passes or fails:

1. **Transactional enqueue from Prisma 7.** Inside `prisma.$transaction`, write a row, then call `SELECT dbos.enqueue_workflow(...)` with portable JSON arguments. A rollback leaves no workflow, and a commit runs it. Also try `enqueueInTransaction` with the client underneath `@prisma/adapter-pg`. Confirm DBOS's schema can share ostra's database.
2. **Killed replica.** Two core replicas, each with its own executor ID. `kill -9` one mid-step. The sweeper calls `recoverWorkflows` on it. Measure the time to resume, and check that a fake GitHub that counts idempotency keys sees no duplicate side effect (F-046, F-048).
3. **Upgrade mid-workflow.** Pin `applicationVersion`, start workflows, change the workflow code (adding a step behind `DBOS.patch`), restart. In-flight workflows finish, with no `DBOSStepNondeterminismError`. Repeat with the default hash version, to record the failure that pinning avoids.
4. **Limits per credential.** A partitioned queue: `partitionConcurrency: 2`, `partitionRateLimit` 30 a minute, `priority` on. Push 1,000 workflows across 20 partition keys through 3 replicas. Check that the caps hold across replicas, that ordering is fair, and measure dequeue latency and Postgres CPU and connections.
5. **Schedules.** Create 200 runtime schedules, one per board, restart replicas while they run, and turn on `automaticBackfill`. Check that each tick runs exactly once, and that removing a schedule stops it.
6. **Timers.** Delayed workflows as the 14-day cleanup and the max-duration timer (shortened), survive restarts, and can be cancelled. On wake, a workflow checks state and does nothing if the task has moved on.
7. **Enqueue from Next.js.** The Next.js process enqueues with `DBOSClient` or SQL, without `DBOS.launch()`. Only the core service runs workers (ADR 0016).
8. **Strict types.** The spike compiles under `AGENTS.md`'s `tsconfig` (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`) and the `strict-type-checked` lint rules. Note any `@ts-expect-error` needed at the seam.
9. **Retention.** Find the open-source API, or the safe SQL, for deleting completed workflow history. Confirm the system tables used by the admin views are a stable interface, not internals.

**Open questions the spike won't settle:**

- **DBOS's open-source direction.** The Conductor client moved to a commercial package in October 2026, and auto-upgrade and sharding are Enterprise features. Will the MIT core keep getting what ostra uses? Mitigation: the seam in `packages/jobs`, short workflows, and the option of forking the MIT core. Recheck at each major release.
- **pg-boss's bus factor.** One maintainer, though sponsored by Supabase and others ([README](https://github.com/timgit/pg-boss/blob/master/README.md)). This matters if it becomes the fallback.
- **Hosted version.** Is one shared Postgres per hosted region enough for many installs' DBOS tables, or does the hosted product need sharding (an Enterprise feature)? It doesn't matter for v1 self-hosting (ADR 0001). Revisit with the hosted version.
- **Postgres poolers.** DBOS's and pg-boss's LISTEN/NOTIFY and session use behind PgBouncer in transaction mode: pg-boss's LISTEN/NOTIFY "doesn't work" there ([workers](https://pgboss.io/api/workers)). For DBOS this is **unverified**. Affects installs on managed Postgres with a pooler in front.
- **DBOS funding and team size.** **Unverified** beyond the 2024 seed reported by a company-data aggregator.
