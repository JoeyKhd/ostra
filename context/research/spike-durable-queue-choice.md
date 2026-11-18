# Research: Spike 8, `durable-queue-choice`: does pg-boss cover ostra's background work?

**Status:** Research, 2026-11-18. Feeds ADR 0037 (background work on pg-boss), Q24, ADR 0016 (the server's roles), ADR 0017 (Postgres only), F-043, F-044, F-046, F-048, F-067, F-068, F-106 and F-117, and `research/durable-execution.md`, whose order of the two libraries ADR 0037 reversed.
**Method:**
- I ran `pnpm spike` once in `spikes/durable-queue-choice/` on 2026-11-18, on Windows 11 Pro (10.0.26200) with Node 24.14.0, pnpm 11.28.2 and an embedded Postgres 18.6. It started at 21:32:07Z and ended at 22:00:05Z, 27 min 58 s in all (C7 6.5 s, C1 12.1 s, C2 86.9 s, C3 32.3 s, C4 1,081.6 s, C5 55.3 s, C6 7.9 s, D3 35.1 s, D4 356.5 s; the harness's stdout). I set no `SPIKE_*` variable, so every scenario ran with its defaults. The run exited 1, because the harness returns 0 only when every selected scenario is PASS (`SPIKE/src/harness.ts:288`) and C4 failed. Every result marked "RUN" comes from this one run.
- The machine was busy with other work. Before the run I listed its Node and Postgres processes: vitest runs and another project's embedded Postgres (`.ostra-dev\test\pg-161`), `pnpm run lint` and eslint jobs in a scratch worktree, and MCP servers. None had the spike's path in its command line. Treat every timing as contended.
- After the run, no process whose command line names the spike's path was left, and `.data/harness.pid` was gone (a process listing at 23:00 local). The harness kills its own children (`SPIKE/src/harness.ts`, `shutDown`). I killed nothing else.
- I read the spike as it stands in the working tree. I didn't run git, so I can't say what is committed. The session's start-up git status listed 13 spike files as modified and `src/dbos/` and `src/scenarios/schedule-judge.ts` as untracked, so the code that ran includes uncommitted work.
- **One risk to the run.** Other sessions committed seven times while it ran (`.git/logs/HEAD`: 21:33:11Z, 21:35:26Z, 21:38:26Z, 21:40:42Z, 21:43:30Z, 21:47:21Z, 21:49:44Z). Each time I looked, every modified spike file had a new mtime about 1 s after a commit (21:38:27Z, then 21:40:43Z), and their line counts were the same as before. I can't tell what rewrote them, or whether a replica was ever started from a file in another state. The two earlier touches are overwritten, so I can't rule out that C2's no-lookup control (its kill is logged at 21:33:23Z) or C4's restarts at 21:35:37Z were near one (inferred). No replica logged a start error, and every scenario ran its own assertions. A rerun would settle it.
- Earlier runs of the same day (18:58 to 21:24Z) are in the README. Their `.runs/<stamp>/results.json` files are still on this machine, and I re-read the verdict and summary of each. They agree with the README's table. The numbers inside the README's tables I didn't re-derive: they are marked "README, not rerun". The fix runs of C4 and the DBOS runs of D4 other than today's are in that group.
- I read the official docs on 2026-11-18: pg-boss at pgboss.io (its old address, `timgit.github.io/pg-boss`, answers 301 to it), DBOS at docs.dbos.dev, PostgreSQL and Node. I also read the installed source of pg-boss 12.38.2, `@dbos-inc/dbos-sdk` 5.6.0 and `@prisma/adapter-pg` 7.10.1 under `SPIKE/node_modules`. The line numbers I cite there are in the installed JavaScript and change with the version. The docs came through a fetch tool that returns a summary of the page. The quotes below are as it returned them, and I didn't compare them with the raw pages. Where a page said nothing on a point, I say so.
- Anything I read in the code and didn't run is marked "inferred". Anything I couldn't check against a primary source is marked **unverified**.

**Source links.**
- `SPIKE` means `spikes/durable-queue-choice`. A cite like `SPIKE/src/jobs.ts:200-208` is a file and its lines.
- `RUN` means the output of today's `pnpm spike`, cited by scenario. Its structured copy is `SPIKE/.runs/2026-11-18T21-32-07-101Z/results.json`, and the logs of every replica and panel are in the folders beside it. `.gitignore` excludes `.runs/` (`SPIKE/.gitignore`), so they stay on this machine. The harness's stdout is in the session's scratchpad, not in the repo.
- `README` means `SPIKE/README.md`. `PASSBAR` means the spike's pass bar, `context/build-order.md:164-175`. `ADR37` means `context/decisions/0037-background-work-on-pg-boss.md`. `LEDGER` means `context/features.md`. `DURABLE` means `context/research/durable-execution.md`.
- `PGBOSS` means `SPIKE/node_modules/pg-boss/dist/`, `DBOS` means `SPIKE/node_modules/@dbos-inc/dbos-sdk/dist/src/`, and `PRISMAPG` means `SPIKE/node_modules/@prisma/adapter-pg/dist/index.js`. `JOBS` means `packages/jobs/src/`, which ticket 23 built from this spike (`context/specs/m1-first-pr/issues/23-jobs-package.md`).

---

## Facts (checked 2026-11-18)

| Thing | Version | License | Note | Source |
|---|---|---|---|---|
| pg-boss | 12.38.2, exact pin | MIT | npm `latest`, last modified 2026-11-10. Needs Node 22.12 or later. The queue under test. The docs: "pg-boss is open source under the MIT license." | `SPIKE/package.json`; `npm view pg-boss`; pgboss.io/introduction |
| `@dbos-inc/dbos-sdk` | 5.6.0, exact pin | MIT | npm `latest`. The fallback. Its MIT core only: no Conductor, no Enterprise package. Spike-only (README:338) | `SPIKE/package.json`; `npm view @dbos-inc/dbos-sdk`; `SPIKE/node_modules/@dbos-inc/dbos-sdk/package.json` |
| Prisma (`prisma`, `@prisma/client`, `@prisma/adapter-pg`) | 7.10.1, exact pin | Apache-2.0 | README, not rerun (README:339-341) | `SPIKE/package.json` |
| Postgres | 18.6 | PostgreSQL License | From `embedded-postgres` 18.6.0-beta.19 (MIT), a beta. Started with `fsync=off`, `full_page_writes=off` and `max_connections=400`. ADR 0007 now records it as a development dependency only | RUN, "postgres 18.6 ready (embedded)"; `SPIKE/src/cluster.ts:182-183`; `context/decisions/0007-web-app-libraries.md:47` |
| TypeScript | 5.9.3 | Apache-2.0 | `tsc --noEmit` took 1.7 s in C7 | RUN, C7 |
| `zod`, `pg` | 4.6.7, 8.23.1 | MIT | README, not rerun (README:342,344) | `SPIKE/package.json` |

---

## 1. The question, and the answer

**Question.** Does pg-boss cover ostra's background work? It tests ADR 0037 and Q24, with ADR 0011 (nothing is acted on before it's saved), ADR 0016 (the panel enqueues, the core service works) and ADR 0017 (Postgres only). If it fails, the bar says to run the failed scenario on DBOS and compare (`PASSBAR`; `SPIKE/README.md:5-21`).

**Answer.** Mostly yes, with one change to how schedules work. On one Windows laptop, 6 of the 7 criteria passed and C4 failed, with no scenario skipped (RUN, my count of its rows).
- A job enqueued through `fromPrisma(tx)` exists only if its transaction commits.
- After `kill -9` of the replica holding all six jobs, the other replica ran them 15.1 s later, and a fake GitHub counted 6 POSTs for 6 keys at each of three kill points.
- A limit of 2 per key held for running work: the handlers never ran more than 2 in a group, in either pass. The committed job table did show up to 5 active in one group, for at most 61 ms.
- Delayed jobs survived `kill -9` of every replica and could be cancelled.
- The panel enqueued with no worker alive.
- The spike compiles under the strict flags and the repo's lint rules.

C4 failed: 200 schedules created at runtime did not each fire once per tick while replicas restarted. Of 4 kills aimed at a replica holding pg-boss's schedule-forwarding batch, 3 stranded it, and nothing noticed for 15 minutes. 44 of 800 (schedule, tick) pairs fired 15.1 minutes late, and 106 occurrences fired a second time when pg-boss replayed the batch. Every earlier default-configuration run that stranded a batch failed the same way (3 of 3, counting this one).

The cause is inside pg-boss: its internal forwarding queue has no heartbeat, and its replay sends again what was already sent. A heartbeat on that queue plus a singleton slot on each schedule closed it in 4 of 4 earlier runs (README, not rerun), but that is an argument about timing, and it reaches into a queue the docs don't name.

The fallback was run. DBOS Transact passed C3 with no overshoot in the committed state, and passed C4 with every pair exactly once. But the harness restarts a killed replica under the same executor ID, which DBOS's docs require. With a new ID per process, DBOS lost 400 of 800 pairs (README, not rerun).

**Recommendation: keep pg-boss (ADR 0037), and don't start work from pg-boss's own cron.** A schedule that starts work is a row in ostra's tables with a unique key per occurrence, ticked by one job a minute (section 4). That design isn't built or tested. A run of C4's kills against it is the check that it works.

Everything ran on one loaded Windows machine, on Postgres with `fsync=off` and `LISTEN/NOTIFY` off. Linux, macOS and other Postgres versions haven't run.

---

## 2. Results per pass-bar criterion

`PASSBAR` has seven bullets. The harness runs each as a criterion (C1 to C7) and prints PASS only when the scenario's own assertions hold. A scenario that throws is a FAIL, and one with no Postgres is SKIPPED (`SPIKE/README.md:243`). The build order's fallback, C3 and C4 on DBOS, runs as D3 and D4 in the same harness (`SPIKE/src/harness.ts:42-53`).

| # | Criterion | Result | What keeps it from a clean PASS |
|---|---|---|---|
| C1 | A job enqueued inside a Prisma 7 transaction exists only if the transaction commits | **PASS** | Windows only; Prisma 7.10.1 only |
| C2 | `kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate | **PASS** | One replica held all six jobs every time; the recovery time rests on 5 s supervise passes; no stalled-but-alive replica; a fake GitHub |
| C3 | A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys; any brief overshoot is recorded | **PASS** (overshoot recorded) | The committed table showed up to 5 active in one group for up to 61 ms |
| C4 | 200 schedules created at runtime each fire once per tick while replicas restart | **FAIL** | The failure is pg-boss's own cron. A fix passed 4 of 4 earlier runs |
| C5 | Delayed jobs survive a restart and can be cancelled | **PASS** | Windows only |
| C6 | The panel process enqueues without running workers | **PASS** | A panel that starts before any core can't start (surprise 8) |
| C7 | It compiles under ostra's strict flags | **PASS** | None |
| D3 | C3 on DBOS | **PASS** | The harness's table view reads "peak 3" for a 0 ms tie; the committed peak was 2 |
| D4 | C4 on DBOS | **PASS** (kill window under-exercised: 2 of 3 target kills stranded fires) | A killed replica is restarted under the same executor ID; with a new ID per process it failed (README, not rerun) |

Source for every row: RUN, the scenario named in the row (`results.json`); `SPIKE/src/scenarios/`; `SPIKE/src/dbos/`.

### 2.1 C1, transactional enqueue: PASS

The panel is a pg-boss producer in its own process. It writes the task row and the job in one Prisma transaction, and the job goes through `boss.send(..., { db: fromPrisma(tx) })` (`SPIKE/src/jobs.ts:200-208`). Eight cases ran (`SPIKE/src/scenarios/c1-transactional-enqueue.ts:1-15`).

| Case | Result (RUN) |
|---|---|
| A. The transaction throws after the enqueue | PASS: no job row, no task row, no run, after 2 s of worker polling at 0.5 s |
| B. It commits | PASS: the job exists, a replica ran it, the task moved `queued` to `prepared` |
| C. Held open | PASS: for 3 s another connection saw no job and no task row, and the worker ran nothing; after the commit the job ran |
| D. `kill -9` of the panel with its transaction open | PASS: no job, no task row, no run |
| E. Control: the job sent on pg-boss's own pool in the same code | PASS: after the rollback the job row stays (1 job, 0 task rows). So A to D are not an accident of timing |
| F. A fixed key (`task:<TaskId>:<transition>:<seq>`) sent twice in one transaction | PASS: first `enqueued`, second `deduplicated`, one job row |
| G. Control: the same two sends on a standard queue | PASS: two jobs. A `singletonKey` alone doesn't deduplicate |
| H. The same key again after the first job completed | PASS: a new job; the handler found the task already moved on and did nothing |

Source: RUN, C1 evidence.

- The docs say the same about the adapter: operations "accept a `db` option that lets you run them inside an existing database transaction", which is "how you ensure that job creation (or completion) is atomic with your application's own writes", and `fromPrisma` "Requires Prisma v7+ with `@prisma/adapter-pg`" ([adapters](https://pgboss.io/api/adapters)).
- A fixed key needs an `exclusive` queue. The docs list it as "Only allows 1 job to be queued or active. Can be extended with `singletonKey`" ([queues](https://pgboss.io/api/queues)). `send()` then returns `null` for the duplicate: "`send()` may resolve a `null` instead of a job id" ([jobs](https://pgboss.io/api/jobs)). So it doesn't hand back the existing job, and `JOBS/jobs.ts:171-179` looks it up.
- Case H is why rule 1 of ADR 0037 matters. The key is free once the job has completed, so only the handler's check of the task's state makes the second job harmless (`ADR37:8`).
- The spike's `send()` still looks the queue up through pg-boss's own pool, so a producer needs a small pool of its own, and the queue must already exist (README:249).

### 2.2 C2, `kill -9` mid-job: PASS

Two replicas, six jobs. Each handler looks the pull request up by its branch, creates it if it isn't there, and records a row at each step (`SPIKE/src/handlers.ts:48-67`). The replica holding the jobs gets SIGKILL, and the harness's `kill -9` is `TerminateProcess` on Windows (`SPIKE/src/proc.ts:1-6`; [Node process docs](https://nodejs.org/api/process.html): "Sending `SIGINT`, `SIGTERM`, and `SIGKILL` will cause the unconditional termination of the target process"). The heartbeat is 10 s and the supervise and monitor passes run every 5 s (`SPIKE/src/job-defs.ts:12-19`; `SPIKE/src/kit.ts:132-140`).

| Kill point | Result (RUN) |
|---|---|
| C2: after all six effects landed and were recorded, jobs still running | PASS: all 6 re-ran on replica-1; 6 POSTs for 6 keys; the lookup by branch found the pull request 6 times and skipped the call. Kill to the first retried attempt 15.1 s, to the last job done 15.5 s |
| C2 control: the same, with a handler that has no lookup | 12 POSTs for 6 keys, 6 keys duplicated |
| C2b: in the check-then-POST gap (the fake counted all 6 POSTs and held the responses for 10 s; the victim had recorded 0 `created` rows) | PASS: the retries found the pull requests by branch; 6 POSTs for 6 keys |
| C2b control: no lookup | 12 POSTs for 6 keys, 6 keys duplicated. The gap is real |
| C2c: before the effect (the fake held 6 requests it hadn't counted, and dropped them when the client died; 0 POSTs counted at the kill) | PASS: the 6 retries found nothing by branch and created the effect once; 6 POSTs for 6 keys |

Source: RUN, C2 evidence; `SPIKE/src/scenarios/c2-kill-mid-job.ts:1-20`.

- **Delivery is at least once, and the lookup is what prevents the duplicate.** The controls show redelivery is real: a handler without the lookup made 12 POSTs for 6 keys, twice. pg-boss's docs say the same: "Jobs are delivered at least once." ([introduction](https://pgboss.io/introduction)). Redelivery is the queue's behaviour, and a duplicate side effect is the handler's. The check is what keeps the effect single (`ADR37:31`; F-046).
- **The recovery time comes from the settings.** pg-boss's docs give the minimum heartbeat as 10 ("Must be >= 10") and say the monitor fails or retries a job that misses it ([jobs](https://pgboss.io/api/jobs)). The pass intervals default to 60 s ([constructor](https://pgboss.io/api/constructor)). The 15.1 s above rests on passes of 5 s, and the defaults weren't measured (RUN, C2 evidence; README:357). The spike's own comment says the monitor pass is what frees a dead replica's jobs (`SPIKE/src/kit.ts:135-136`). `JOBS/jobs.ts:134-143` sets `superviseIntervalSeconds` to 30 and leaves `monitorIntervalSeconds` at its 60 s default, so as written a dead replica's jobs would take about 10 s plus up to 60 s (inferred, not run).
- One replica took all six jobs at its first poll in every run (the kill lines in RUN say "holds 6 of 6 jobs"). So the survivor never had jobs of its own. An earlier run split them 3 and 3 and the survivor's own jobs ran undisturbed (README:264). In the very first run the survivor had no free worker and the jobs waited 29.7 s for one, so replicas need headroom (README:263).
- **Not covered.** A replica that is stalled but alive and wakes after its jobs were given away. The docs say "a heartbeat that finds a job no longer active under this worker's claim aborts that job's signal" ([workers](https://pgboss.io/api/workers)), and the handler here passes `job.signal` to its wait (`SPIKE/src/handlers.ts:63`). But Windows has no `SIGSTOP`, so it didn't run (RUN, C2 evidence).
- **The fake GitHub counts an `Idempotency-Key` header** (`SPIKE/src/fake-github.ts:1-20`). That is the bar's counting device, and the real guard is the lookup by branch. Whether GitHub honours such a header, and how it answers the lookup right after a create, are not tested here. Spike 4 owns the real GitHub (RUN, C2 evidence).

### 2.3 C3, a limit per key: PASS, with an overshoot (and D3 on DBOS)

Three replicas with 16 workers each (48 workers for 40 slots), `groupConcurrency: 2`, jobs sent with `group: { id: key }`. Two passes: 1,000 jobs of 40 to 100 ms on 20 keys (the bar's load) and 200 jobs of 2 to 4 s (what an overshoot costs with realistic jobs). Concurrency is read three ways: back-to-back snapshots of the committed `pgboss.job` rows in state `active` (the primary measure), the job table's own timestamps, and the handlers' own start and end rows (`SPIKE/src/scenarios/c3-group-limit.ts:1-33,128-219,259-307`).

| Measure (RUN) | pg-boss, short pass | pg-boss, long pass | DBOS (D3), short pass | DBOS (D3), long pass |
|---|---|---|---|---|
| Jobs, time, rate | 1,000, 12.6 s, 79.2 jobs/s | 200, 17.1 s, 11.7 jobs/s | 1,000, 13.7 s, 73.0 jobs/s | 200, 19.1 s, 10.5 jobs/s |
| Each job ran once, none retried | yes | yes | yes | yes |
| Committed snapshots | 43,820 polls; peak 5; 247 (0.56%) above 2; longest episode 12 ms | 45,354 polls; peak 3; 155 (0.34%) above 2; longest 61 ms | 69,311 polls; peak 2; none above | 74,020 polls; peak 2; none above |
| Job table timestamps | peak 3 | peak 3 | peak 2 | peak 3 (a tie, see below) |
| Handlers' own records | peak 2 | peak 2 | peak 2 | peak 2 |

Source: RUN, C3 and D3 evidence.

- **The limit held for running work.** The handlers never ran more than 2 in a group in either pass. Across the four earlier runs, the committed peaks were 4 to 7, the longest episodes 20 to 58 ms, and the share of snapshots above 2 was 0.13% to 0.82%. The handlers peaked at 2 in every pass of every run the README records, and in both passes of RUN (README, not rerun: README:73-76,284).
- **The overshoot is real, brief, and doesn't grow with the job.** The longest episode was 12 ms with 40 to 100 ms jobs and 61 ms with 2 to 4 s jobs (RUN, C3 evidence). The worry was that an over-admitted job would run for as long as a job lasts. It doesn't, because pg-boss gives the extra jobs back before any handler starts.
- **The docs say so.** On `groupConcurrency`: "Concurrent fetches can briefly claim past the limit." and "Each fetch counts its groups again after claiming and gives the extra jobs back before any handler runs." ([workers](https://pgboss.io/api/workers)). The source agrees. The claim reads the group's active count in a materialized CTE and locks with `FOR UPDATE OF j SKIP LOCKED` (`PGBOSS/plans.js:2398,2410`). After its own commit, each fetch counts again and gives its excess back (`PGBOSS/manager.js:1909-1953`, whose comment says "of two racing fetches at least the later count sees both and gives back, before any handler runs"). So it is an argument from the order of statements, and not a lock (README:99-107).
- **DBOS does it with a lock.** A claim on a queue with a shared budget opens a transaction and takes `pg_try_advisory_xact_lock` on the queue's scope, counts the pending workflows and claims only the room left (`DBOS/system_database.js:936-951,3397-3408`). The docs: `partitionConcurrency` is the "Maximum workflows from any one partition running at once across all processes." ([queue tutorial](https://docs.dbos.dev/typescript/tutorials/queue-tutorial)). A claimer that misses the lock claims nothing until its next poll (`DBOS/system_database.js:3403-3408`), which may be part of why DBOS ran the short pass at 73.0 jobs/s against pg-boss's 79.2 (inferred; README, not rerun: 67.2 to 71.5 against 81.6 to 85.9, README:73-79).
- **D3's "peak 3" is not an overshoot.** The table view of DBOS stores whole milliseconds, so a job that starts in the millisecond its predecessor ended ties with it, and the sweep orders a start before an end at the same instant on purpose (`SPIKE/src/scenarios/c3-group-limit.ts:77-78`; README:81). That is why D3's summary reads "peak 3 ... longest 0 ms" while its committed snapshots never showed more than 2.
- The limit is an option of each `work()` call and isn't stored in the database, so every replica must pass the same value (README:282; `SPIKE/src/jobs.ts:222-238`).

### 2.4 C4, 200 runtime schedules: FAIL (and D4 on DBOS)

The panel creates 200 schedules at runtime (`* * * * *`, one per board). Half use pg-boss's default options (plain), and half also carry a singleton key and a 60 s slot on the jobs they create (guarded). Three replicas run the schedule pass and a worker that records every fired job (`SPIKE/src/scenarios/c4-schedules.ts:1-40`).

**How the kill is aimed.** pg-boss's cron pass inserts each due occurrence into an internal queue, `__pgboss__send-it`, and every replica works that queue 50 at a time (`PGBOSS/timekeeper.js:13,291-296`). A batch is `active` for tens of milliseconds a minute, so a kill timed by the clock never reaches it. The scenario polls that queue back to back, and the moment a batch is `active` it kills every replica but one. It reads the batch again 3 s later: still `active` means the holder was among the killed and the batch is stranded (`c4-schedules.ts:198-270`). A graceful stop and restart runs at the first tick as well. After the last tick the schedules are removed, and the scenario waits up to 17 minutes for pg-boss to free a stranded batch (`c4-schedules.ts:283-301`). The first version of this scenario, whose kills never landed in a batch, passed in each of three runs (README:32).

**RUN.**

| | Result |
|---|---|
| Kills issued while a batch was active | 4 (at -115.4, -85.4, -57.0 and +3.0 s from the first tick); 3 stranded a batch of 50 each, and 1 found it finished by a survivor |
| Pairs | 800 expected: 756 fired exactly once, **44 missed**, 0 doubled in a tick |
| The 44 | All in tick 0, all fired 15.1 minutes after it, when pg-boss freed the batch and replayed it |
| The replay | **106 occurrences fired a second time**: all 100 of the stranded warm-up occurrences (they had been sent before the kill) and 6 of tick 0's 50 |
| Plain vs guarded | Plain 379 of 400 exact, 21 missed; guarded 377 of 400 exact, 23 missed. The guard changed nothing for a missed pair. The replay came 15 minutes later, in another minute's slot, so a singleton slot can't dedupe it (README, not rerun, saw guarded schedules repeated too: README:51) |
| When the stranded batches were freed | 901.8, 901.9 and 903.4 s after their kills, 665 s after the run's end |
| Fires that came on time | p50 6.3 s, p95 8.4 s, max 8.4 s after the tick |

Source: RUN, C4 evidence; `c4-schedules.ts:308-316,424-432`; `SPIKE/src/scenarios/schedule-judge.ts:58-161`.

**All the runs so far.** "Fix" means a heartbeat of 10 s on the forwarding queue and a singleton key plus a 60 s slot on every schedule (`SPIKE_SEND_IT_HEARTBEAT_SECONDS=10 SPIKE_SCHEDULE_GUARD=all`, README:41).

| Run (UTC start) | Library and configuration | Verdict | Pairs exact / missed / doubled | Kills in the window, of them stranding | Stranded work came back |
|---|---|---|---|---|---|
| 21:32 (RUN) | pg-boss, defaults | **FAIL** | 756 / 44 / 0, plus 106 repeated by the replay | 4, 3 | 15 minutes after the kill |
| 18:58, 20:52 (README, not rerun) | pg-boss, defaults | **FAIL**, **FAIL** | 672 / 128 / 0 plus 22 repeated; 750 / 50 / 0 plus 62 repeated | 5, 3; 3, 3 | 15.3 to 17.3 min; 902 to 906 s |
| 19:22 (README, not rerun) | pg-boss, forwarding expiry 30 s, half guarded | **FAIL** | 800 / 0 / 0, but 5 plain schedules fired 3 times in a 2-occurrence warm-up | 3, 3 | about 1 min |
| 20:46 (README, not rerun) | pg-boss, heartbeat 10 s only, half guarded | **FAIL** | 798 / 0 / 2, and 3 plain schedules over-fired in the warm-up; guarded 400 / 400 | 4, 3 | 13.4 to 18.5 s |
| 19:53, 20:04, 20:18, 20:32 (README, not rerun) | pg-boss, **fix** | **PASS** x4 | 600 / 800 / 800 / 800 exact, none missed or doubled | 5, 2; 5, 3; 4, 3; 3, 3 | 13.4 to 18.6 s |
| 21:32 (RUN) | DBOS, stable executor ID per slot | **PASS** (under-exercised) | 800 / 0 / 0 | 4, 2 (200 fires each) | on the restart: all 400 |
| 20:32, 21:18, 21:24 (README, not rerun) | DBOS, stable executor ID | **PASS** x3 | 800 / 0 / 0 each | 4, 2; 4, 3; 3, 3 | on the restart |
| 19:53, 20:04, 20:18 (README, not rerun) | DBOS, stable executor ID | FAIL on the harness's extra check; every pair exactly once | 600 / 800 / 800 exact | 3, 3; 4, 3; 3, 3 | on the restart |
| 20:52 (README, not rerun) | DBOS, **a new executor ID per process** | **FAIL** | 400 / 400 / 0 | 5, 2 | **never**: 400 stayed `PENDING` under dead executor IDs |

Source: RUN; README:47-63; the verdict and summary of each earlier run re-read from its `.runs/<stamp>/results.json`.

**Why pg-boss failed.** Two defects together, both in the installed source (README:85-90):
1. **A dead holder strands a batch for 15 minutes.** The forwarding queue is created with no options (`PGBOSS/timekeeper.js:291`), so it has pg-boss's default expiry of 15 minutes and no heartbeat (`PGBOSS/plans.js:85-86`; docs: `expireInSeconds` "Default: 15 minutes", `heartbeatSeconds` "none (disabled)", [queues](https://pgboss.io/api/queues)). A replica killed while it holds a batch leaves 50 occurrences `active` until the expiry.
2. **The replay sends again what was already sent.** The handler sends the batch's real jobs in parallel, each in its own statement (`PGBOSS/timekeeper.js:712-717`), so when the holder dies some of the 50 exist and the forwarding job is still `active`. The retry sends all 50 again. The occurrence's slot is stripped before the real send (`const { key, slot, ...request } = data`), so the only thing that can drop a second send is the schedule's own singleton options: the unique index `job_i4` on `(name, singleton_on, singleton_key)` counts completed jobs too (`PGBOSS/plans.js:1248`), but the slot is computed from the replay's own clock (`PGBOSS/plans.js:2861`). So it dedupes only if the replay lands in the same minute.

**Why the fix works, and what it isn't.**
- **Part 1.** `updateQueue("__pgboss__send-it", { heartbeatSeconds: 10 })` after `start()` (`SPIKE/src/jobs.ts:192-194`). `updateQueue` sets `heartbeat_seconds`, and a job takes its queue's value when it is inserted (`PGBOSS/plans.js:1565-1585,2875`). A stranded batch then fails on a missed heartbeat and is replayed 13.4 to 18.6 s after the kill, instead of after 15 minutes (README:94).
- **Part 2.** A singleton key and `singletonSeconds: 60` on every schedule, so the replay's second sends fall in the same slot. Part 1 alone failed (the 20:46 run, above) (README:95).
- **It is a timing argument.** The replay dedupes only inside the same minute. The first send comes up to 30 s after the tick (the cron pass runs every 30 s) plus the 5 s forwarding poll, and the replay adds 13 to 19 s, so the margin is about 10 s. The latest fire in the fix runs was 44.7 s after its tick (README:97). pg-boss's docs give the 30 s: "schedules are checked every 30 seconds and a job is filed under the minute its occurrence falls in" ([scheduling](https://pgboss.io/api/scheduling)). The defaults are in the source (`PGBOSS/attorney.js:709-712`: `cronMonitorIntervalSeconds` 30, `cronWorkerIntervalSeconds` 5).
- **It reaches into internals.** The queue's name and options aren't named on any of the pg-boss docs pages I read, so a pg-boss upgrade can undo the fix silently. Occurrences inserted before the first replica's `updateQueue` carry no heartbeat (README:97).
- **The docs rest the one-job guarantee on those same options.** "job throttling options are then used to make sure only 1 job is sent even if multiple instances are running" ([scheduling](https://pgboss.io/api/scheduling)). So the guarantee ADR 0037 states, one job "however many replicas run" (`ADR37:25`), holds when no replica dies holding a batch, and the docs word it as a throttle.

**Why DBOS passed, and what it needed.**
- **Its scheduler cannot fire a tick twice.** The docs: "The key is a concatenation of the schedule name and the scheduled time", "Each time a schedule fires, its workflow is executed by exactly one worker process", and "ensuring each scheduled invocation occurs exactly once while your application is active" ([scheduled workflows](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows)). In the source each tick's workflow ID is `sched-<schedule>-<tick ISO>`, inserted with the rest of the tick in one transaction that also stamps `last_fired_at`, and an existing ID is skipped (`DBOS/scheduler/scheduler.js:477-499`; `DBOS/system_database.js:1399-1416`). Fires were created 0.13 s after the tick at p50 and 0.86 s at the maximum (RUN, D4 evidence). pg-boss's were 6.3 s and 8.4 s (RUN, C4 evidence).
- **Recovery hangs on the executor ID.** "When an executor launches, it recovers its own `PENDING` workflows." and "give each executor a unique, stable executor ID through DBOS configuration"; for an executor that is gone for good, `DBOS.recoverWorkflows` from another one; and "when Conductor detects that an executor is unhealthy, it signals another executor to recover its workflows" ([workflow recovery](https://docs.dbos.dev/production/workflow-recovery)). Without Conductor, `launch` recovers only its own executor's work (`DBOS/dbos-executor.js:168-173`). D4 restarts a killed replica under its slot's executor ID (`SPIKE/src/dbos/d4-schedules.ts:94-106,218`), and the 400 stranded fires all succeeded on the restart (RUN, D4 evidence). A pod with a generated name would get a new ID, and in that variant nothing recovered 400 of 800 pairs (README:63,112).
- **The kill window was under-exercised.** 2 of the 3 target kills stranded fires, in 4 tries. Each stranded a whole tick of 200, because one replica claimed all 200 at once (RUN, D4 evidence; README:67).

### 2.5 C5, delayed jobs: PASS

Seven delayed jobs, each enqueued in a Prisma transaction with its task row (`SPIKE/src/scenarios/c5-delayed-jobs.ts:1-12`).

| Case | Result (RUN) |
|---|---|
| A and B: due in 45 s, every replica killed at 4 s and replacements started at 18 s (A), then those stopped gracefully and replaced again (B) | PASS: each ran exactly once, 0.4 s after falling due, never early |
| F: due in 12 s, no replica alive then | PASS: ran once, only after the new replicas started, 0.4 s after the restart began (6.3 s after it fell due) |
| E: its task moved on before the wake | PASS: the handler found the state changed and did nothing |
| C, D, G: cancelled with the replicas up, with every replica dead, and after the restart | PASS: each ended `cancelled`, never ran, its task untouched |

Source: RUN, C5 evidence.

- A delay is a start time in the table, so it survives any number of dead replicas, and the first worker to start after the due time runs it (inferred from case F). The docs: a string without an offset "is interpreted as UTC, so the instant does not depend on the database's time zone", and "Any other string is read as a relative delay from now" ([jobs](https://pgboss.io/api/jobs)).
- `JOBS/jobs.ts:107-113` rounds a delay up to whole seconds, because pg-boss counts a delay in whole seconds.
- Cancelling a job by key is `findJobs` then `cancel` (`JOBS/jobs.ts:275-286`). The docs warn that cancelling several ids "may partially succeed based on the state of individual jobs requested" ([jobs](https://pgboss.io/api/jobs)).

### 2.6 C6, the panel enqueues without workers: PASS

Step 0 starts a panel against a database where no core has run. Then a core boots once and stops. The panel enqueues in a Prisma transaction with no worker alive anywhere, and a core replica starts and runs the job (`SPIKE/src/scenarios/c6-panel-no-workers.ts:1-13`).

| Check (RUN) | Result |
|---|---|
| Step 0: a panel started against a database with no pg-boss schema | start() failed: `Error: pg-boss is not installed`. The panel created no schema |
| The panel's job with no replica alive | sat in `created` for 6 s (12 poll intervals); nothing ran it |
| The panel's own row in pg-boss's registry | `supervise` false, `schedule` false, `migrate` false, 0 worker registrations |
| A replica started | ran the job, recorded under its own ID; the job completed |
| `stop()` on the panel | the process exited with code 0 by itself in 30 ms, before its 5 s safety timer |

Source: RUN, C6 evidence.

- The three switches are pg-boss's own options: `migrate`, `supervise` and `schedule`, each default true, each "skipped on this instance" when false ([constructor](https://pgboss.io/api/constructor); `SPIKE/src/jobs.ts:159-169`). pg-boss then only checks the schema version on start, and that check is what failed in step 0 (README:250).

### 2.7 C7, strict compile: PASS

`tsc 5.9.3 --noEmit` exited 0 in 1.7 s with all 8 flags of `AGENTS.md` set, over pg-boss's types and the generated Prisma 7 client. A scan of 31 source files on their syntax trees found no `as` but `as const`, no `!`, no `any`, no enum, interface, class or default export, no sync API, no `@ts-ignore`, and pg-boss imported only by `src/jobs.ts` and DBOS only by `src/dbos/jobs.ts`. The repo root's ESLint rules (strict-type-checked and stylistic-type-checked, plus the repo's own) reported 0 problems (RUN, C7 evidence; `SPIKE/src/scenarios/c7-strict-compile.ts`). The README's row says 25 files and is out of date (README:35). `boss.work<Data, Result, typeof options>()` needs its third type argument, or the handler loses its metadata typing (README:318).

---

## 3. What surprised us, and the gotchas

**Surprises**

1. **The first C4 passed three times and was wrong.** Its kills were timed by the clock and never landed in a forwarding batch, so 2,400 pairs came out exact (README:32). The scenario failed once a hunt aimed kills at the replica holding a batch (`c4-schedules.ts:7-23`). The pass bar's "while replicas restart" means that kill, not a restart at a set time.

2. **The damage varies with what the dead holder had already sent.** With defaults, the same failure showed as 128 missed and 22 repeated (18:58), 50 missed and 62 repeated (20:52), and 44 missed and 106 repeated (RUN). In RUN two of the three strikes hit warm-up batches that had been sent, so the replay repeated them. A schedule that starts a task gets either a task 15 minutes late or a second task, depending on where the kill fell.

3. **pg-boss's one-job promise is a throttle.** The docs say that "job throttling options are then used to make sure only 1 job is sent even if multiple instances are running", and that "an occurrence that came due while no instance was running a pass is not sent at all" unless `missed` is set to `once` ([scheduling](https://pgboss.io/api/scheduling)). So a missed tick is skipped by default, and the dedupe lives in a one-minute slot. Neither is a fault, but ADR 0037 reads as if the library gave exactly-once ticks (`ADR37:25`).

4. **The fix works in 4 of 4 and still isn't the design.** It is a timing argument across a 10 s margin, over an internal queue, with a singleton slot that must match the cron's period (section 2.4).

5. **DBOS's scheduler is the stronger design, and its recovery is the weaker one.** The fixed tick ID makes a double fire impossible whatever the timing, and fires arrive at once. But a killed replica's claimed work waits for its own executor ID to return, and the open-source core has no heartbeat on a claim (README:112; `DBOS/dbos-executor.js:168-173`). Without Conductor, ostra would need the sweeper that `DURABLE` describes: a replica table, a dead-replica check, and `DBOS.recoverWorkflows` for a dead executor, never for a live one.

6. **A fixed key needs an `exclusive` queue, and `send()` answers `null` on a duplicate.** A `singletonKey` on a standard queue made two jobs (C1 case G). `packages/jobs` already uses `exclusive` on every queue and looks the existing job up (`JOBS/definitions.ts:6-8`; `JOBS/jobs.ts:171-179`). ADR 0037's "Sending a job twice returns the existing one" (`ADR37:9`) holds only through that package.

7. **A group limit that shows in the table doesn't show in the handlers.** The committed peak was 3 to 7 at a limit of 2, and the handlers never passed 2. Anything that counts `active` rows to know how many jobs run will count the extras.

8. **A panel that starts before any core can't start.** pg-boss with `migrate: false` only checks the schema version, and failed with "pg-boss is not installed" (RUN, C6 step 0). ADR 0016 lets `web` and `core` run as separate replicas (`context/decisions/0016-server-shape.md:7-8`), so a first boot, or a rolling deploy that brings `web` up first, hits it.

9. **Prisma 7 with `@prisma/adapter-pg` stored the wrong instant when the database session wasn't in UTC.** A `Date` written to a `timestamptz` column and read back with SQL was off by 0.00 h in a UTC session and by -5.50 h in an `Asia/Kolkata` session. Reading the row back through Prisma returns the original, so the shift is invisible there and wrong for pg-boss, SQL and any other reader (RUN, observation O1; `SPIKE/src/observations.ts`).
   - **The cause is in the adapter, and Postgres documents the rest.** `formatDateTime` writes the date's UTC fields with no offset (`PRISMAPG:389-392`), and Postgres reads such a string in the session's zone: "If no time zone is stated in the input string, then it is assumed to be in the time zone indicated by the system's TimeZone parameter" ([datetime types](https://www.postgresql.org/docs/current/datatype-datetime.html)). I saw the symptom described in a third-party pull request (umami-software/umami, pull 4321, through a search summary only), and found no mention of it in the Prisma 7.10 release notes. I didn't look in Prisma's issue tracker, and whether a later Prisma changes it is **unverified**.
   - It was found because this laptop's zone is Europe/Berlin. The harness forces UTC on every scenario database (`SPIKE/src/cluster.ts:296`).

**Gotchas**

10. **The group limit is a worker option, not a queue setting.** It isn't stored, so a replica that passes another value, or none, changes the limit for everyone's jobs on that queue (README:282; `SPIKE/src/jobs.ts:222-238`). `JOBS/definitions.ts` has no place for it today.

11. **Heartbeats and passes decide recovery.** The minimum heartbeat is 10 s. With 5 s passes, a dead replica's jobs came back 15.1 s after the kill in C2 (RUN), and a stranded forwarding batch 13.4 to 18.6 s after it (README:94). With pg-boss's 60 s defaults the time would be longer, and it was not measured. A killed replica's jobs also need a survivor with a free worker (section 2.2).

12. **`LISTEN/NOTIFY` was off in every run.** `useListenNotify` defaults to false, and the docs say it doesn't work "through PgBouncer in transaction or statement pooling mode" ([constructor](https://pgboss.io/api/constructor)). So the polling path ran, which is also the supported one behind a pooler. Nothing here tested a pooler, or the notify path (README:355).

13. **DBOS needs its schema migrated once before three replicas launch.** The first D3 run failed one replica's `launch` with `deadlock detected` in DBOS's migrations (`SPIKE/.runs/2026-11-18T19-51-57-201Z/results.json`). D3 and D4 now run `DBOS.migrate(url)` first, as an install step would (`SPIKE/src/dbos/jobs.ts:191-199`). pg-boss's concurrent install, with three replicas booting at once, never failed (README:113).

14. **A deleted DBOS schedule fires once more.** In RUN, 200 workflows were created for the tick after the run, 0.01 s after it, though every schedule had been deleted 10 s earlier. DBOS rereads its schedules every 30 s: "How frequently (in milliseconds) the scheduler polls the database for schedule changes. Defaults to 30000 (30 seconds)." ([configuration](https://docs.dbos.dev/typescript/reference/configuration); `SPIKE/src/dbos/d4-schedules.ts:329-341`). The D4 check was fixed to allow it, and its first three runs failed on it (README:65). Pausing a schedule in ostra's own table would take effect at the next tick.

15. **The harness's wording is loose in places.**
    - C4's summary says "44 of them fired late" of 44 missed pairs. The count behind it takes every stranded occurrence delivered late, warm-up ones too, so it can exceed the missed count (`c4-schedules.ts:325-342,381`). In the 20:52 run it said "88 of them" for 50 missed (`.runs/2026-11-18T20-52-26-555Z/results.json`).
    - "Fire latency" is the time from the tick to the creation of the job (pg-boss `created_on`, DBOS workflow `created_at`), not to the start of the handler (`c4-schedules.ts:407`; `d4-schedules.ts:289-293`).
    - The C3 summary line's "in the job table" is the committed snapshots, and the job table's own timestamps are a separate line.

16. **The cluster is easier on Postgres than a real one.** `fsync=off` and `full_page_writes=off` make commits cheaper. A give-back is itself a commit, so on a real server the overshoot episodes in C3 may be longer than 12 to 61 ms (inferred; `SPIKE/src/cluster.ts:182-183`).

17. **One run today was SKIPPED for want of Postgres.** The 19:30Z run's `results.json` says "No Postgres server could be started" (`SPIKE/.runs/2026-11-18T19-30-32-807Z/results.json`). No log was kept and the README doesn't mention it. It didn't recur: the 11 later runs with a `results.json`, this one included, all started their Postgres (one later folder, 19:52:24Z, holds no results file).

18. **On Windows the checkout path must stay short.** `postgres.exe` cannot open paths of 260 characters or more, and the spike's path uses 219 of 259 (README:235).

---

## 4. What this changes in the plan

These are recommendations for the maintainer. I changed no other file.

**ADR 0037** (`ADR37`):
1. **Record the result.** The gate (`ADR37:54-61`) is answered on Windows: C1 to C3, C5 to C7 pass, and C4 fails on pg-boss's own cron. The "Revisit if" clause (`ADR37:61`) isn't triggered: the limit held for running work, and a killed replica's jobs resumed with no duplicate side effect. The fallback has been run, and its costs are measured: a stable executor ID per replica or ostra's own sweeper, a one-time migrate before three replicas launch, and a deleted schedule that fires once more. Add this to the DBOS option (`ADR37:37-41`).
2. **Reword the schedules line** (`ADR37:25`): "which send one job however many replicas run". Say what holds: one job per tick while no replica dies holding a forwarding batch, and otherwise a tick up to 15 minutes late or repeated. Then the rule: a schedule whose lateness or repeat costs something starts its work from ostra's own table (F-106, below). pg-boss's `schedule()` stays for passes that are idempotent: reconciliation (F-044), insights (F-108) and the model-catalog refresh (`ADR37:14,18`).
3. **Add a consequence.** Pin pg-boss's version, and check at boot that `__pgboss__send-it` carries a heartbeat (set with `updateQueue(..., { heartbeatSeconds: 10 })`). Every `schedule()` also carries a singleton key and a `singletonSeconds` equal to its period.
4. **Reword rule 2** (`ADR37:9`): a duplicate send returns `null`, and it needs an `exclusive` queue. The package looks the existing job up, and after the first job completes the key is free, so rule 1 is what makes the second job harmless.
5. **Add numbers to the group line** (`ADR37:26`): committed peak 3 to 7 at a limit of 2, longest episode 12 to 61 ms, 0.13% to 0.82% of snapshots, and the handlers never above 2 in any pass of any run. It is a throttle, and the limit must be set once per queue, not per replica.
6. **Two more consequences.** (a) The panel's pg-boss `start()` fails with "pg-boss is not installed" before any core has migrated, so a `web` replica retries or waits (ADR 0016's roles, `ADR37:21`). (b) The database runs in UTC (surprise 9): the line goes in the configuration reference, and the server checks `SHOW timezone` at boot or sets `options=-c TimeZone=UTC` on its connections. The `LISTEN/NOTIFY` consequence (`ADR37:52`) stays, and was not exercised (surprise 12).

**F-106, Schedules** (`LEDGER:70`): keep the sentence "Each tick starts its tasks once, however many server replicas run". Change how it is met and how it is tested.
1. **How.** The automation row holds the cron expression (Q10). One pg-boss job a minute, the scheduler tick, finds the due occurrences. Each occurrence is a row, `automation_run (automation_id, occurrence_at)` with a unique key, inserted with `ON CONFLICT DO NOTHING` in the same transaction as its job, and the job's key is `automation:<AutomationId>:<occurrence ISO>`. A replayed tick, a second scheduler or a backfill finds the row and does nothing. This is DBOS's tick ID rebuilt on ostra's tables, and it applies rules 1 and 2 of ADR 0037 to schedules. A scheduler lease (a row, or `pg_try_advisory_xact_lock` as DBOS does) keeps replicas from repeating the work, but correctness doesn't rest on it (README:117-123).
2. **The test.** Add the hunt to F-106's done-when and to the failure suite (F-048): kill every replica but one the moment a tick's occurrences are being inserted or forwarded, and check that each (automation, occurrence) pair started exactly once. Aim the kill at the replica holding the work. A kill timed by the clock passed 3 of 3 and was wrong (surprise 1).
3. **Missed occurrences are a product call.** pg-boss skips them by default, with `once` as the option ([scheduling](https://pgboss.io/api/scheduling)). DBOS can backfill them: "Already-executed times are automatically skipped" ([scheduled workflows](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows)). With ostra's table, `last_fired_at` finds them. Which one an automation gets is a question for the maintainer.
4. **Resolution is one minute.** pg-boss's finest is a minute: "Neither the 6-placeholder cron format's seconds field nor an RRULE's BYSECOND or FREQ=SECONDLY adds precision below a minute" ([scheduling](https://pgboss.io/api/scheduling)). A tick of one a minute is no coarser. On pg-boss's cron the fires' p50 was 4.3 to 16.9 s after the tick and the latest 21.9 s in the default runs, and 46.8 s in the run that replayed a batch (README:303), so an automation that says "Monday at 9" will be a little late either way.
5. **Pause and delete are immediate.** The rows are ostra's, so a paused automation stops at the next tick, where DBOS's schedule fired once more (gotcha 14).

**F-068, Runaway protection** (`LEDGER:99`), and the per-key limits.
1. **Maximum duration is one delayed job per session.** C5 shows what a timer is: a delayed job under a key, which survives `kill -9` of every replica and runs 0.4 s after falling due with replicas up, or 0.4 s after the first replica starts if none was alive. The session's key is `session:<SessionId>:max-duration`. It wakes, checks the state, and does nothing if the session has ended (rule 3). A session that ends cancels it (`JOBS/jobs.ts:275-286`). The same shape serves the task grace (`task.grace`, F-045) and the cleanup after 14 days (F-079).
2. **Stall detection shouldn't be a timer.** "No agent event for 10 minutes" would need a cancel and a send for every event. At spike 6's recorded rate that is about 6,500 events a second at 1,000 sessions (`context/research/spike-runner-transport.md`, section 2.4), which is a write to the queue for every event. Use a sweep instead: one keyed job a minute reads each running session's last event time from ostra's tables, and the 10 minutes becomes 10 to 11. This is inferred, and the spike didn't run it.
3. **The spend cap isn't the queue's.** F-068 says the key proxy enforces it. Nothing here changes that.
4. **Use `groupConcurrency` as a throttle, never as a budget.** It suits a limit where two extra claims, given back in tens of milliseconds, cost nothing: concurrent calls per credential to a tracker or code host, and per-board reconciliation (where an `exclusive` queue with a key already gives one at a time per key). It doesn't suit anything with a cost when exceeded.
5. **F-067's cap per project and per pool stays in ostra's rows.** "No project takes more than its share of a pool" (`LEDGER:98`) is a budget on runner capacity. It belongs to task admission, from ostra's own tables with `FOR UPDATE SKIP LOCKED`, counted inside the transaction that admits (`ADR37:30`). DBOS's lock on the partition, then a count, then a claim of the room left, all in one transaction, is the shape to copy (section 2.3).
6. **Request budgets per credential (Q20, `ADR37:29`) are unchanged.** A call that would overspend becomes a delayed job until the reset. The spike didn't test it.

**Other ledger rows.**
- **F-044** (`LEDGER:220`): the 5-minute bar holds only if a dead holder's batch is freed in seconds. On pg-boss's cron with defaults it was 15.1 minutes late (RUN). So per-board and per-repo reconciliation needs the heartbeat from ADR 0037 item 3. The fires that came on time came a few seconds after their tick: p50 6.3 s and the latest 8.4 s in RUN, and p50 4.3 to 16.9 s and the latest 21.9 s in the README's default runs (README:303).
- **F-046** (`LEDGER:222`): the handler shape of C2 (look the effect up by a marker the handler can recompute, then create it) is the shape to test. Its contract test should keep the no-lookup control, which duplicated in both runs that had one.
- **F-043 and F-048** (`LEDGER:219,224`): the failure suite should include C2's three kill points and C4's hunt.
- **F-117** (`LEDGER:226`): the 1,000-task load test covers the queue (`ADR37:62`). This spike's biggest queue run was 1,200 jobs of C3, on one machine, so it doesn't stand in for that test.

**`packages/jobs`** (ticket 23, resolved). It has `createJobs`, `enqueueInTx`, `schedule`, `cancelInTx` and the `exclusive` queues, and a test for each of C1, C5 and C6. Four gaps follow from this finding:
1. It sets no heartbeat on the forwarding queue and has no boot check (`grep` for `send-it` in `packages/jobs/src` finds nothing). Its `schedule()` passes `key` and `singletonKey` but no `singletonSeconds` (`JOBS/jobs.ts:260-270`). Its two schedules today (`catalog.refresh`, `provider.refresh-models`) are idempotent, so the cost is a late or repeated refresh.
2. `QueueSettings` (`JOBS/definitions.ts:16-25`) has no `groupConcurrency`, and `toSendOptions` (`JOBS/jobs.ts:107-113`) has no `group`. Add both when the first throttled job is built.
3. A test for the panel's start against a database with no schema.
4. A port of C4's hunt as a test of the scheduler tick, once it exists.

**`context/build-order.md`.** The spike-8 row (`context/build-order.md:208`) can name this file and say: Windows only, 6 of 7 pass, C4 fails on pg-boss's own cron, the fallback was run, and pg-boss stays. It waits on a run of C4's hunt against the scheduler tick, and on Linux. The bar's "If it fails" (`PASSBAR`) is done: C3 and C4 ran on DBOS.

**`context/open-questions.md`.** The Q24 row (`context/open-questions.md:75`) says "Spike 8 tests it". It can say that spike 8 tested it and where. New questions for the maintainer, left unnumbered because spike 2's finding already proposes Q128 (`context/research/spike-can-a-session-move-to-a-fresh-box.md:236`):
- What does an automation do for an occurrence that came due while the install was down: skip it, or fire once for the latest?
- Does the `web` role wait for the core's migration, or retry its start?
- Does the server check the database's time zone at boot, or set it on every connection?
- Does `@dbos-inc/dbos-sdk` stay in this spike's dependencies once the finding is written? `AGENTS.md` says to ask before adding a dependency, and it is spike-only (README:338,359).

**No change.**
- ADR 0017 holds: Postgres carried the queue, the schedules, the timers and the limit, with no Redis and no broker.
- Rules 1 and 3 of ADR 0037 held. Handlers that re-check their state made every redelivery and every key reuse harmless (C1 H, C2, C5 E).
- `embedded-postgres` was a question in spike 6's finding. ADR 0007 now records it as a development dependency only (`context/decisions/0007-web-app-libraries.md:47`).

---

## 5. What's still open

**The central recommendation isn't built.** The scheduler tick and the `automation_run` table are a design drawn from DBOS's tick ID and ADR 0037's rules. No code runs them. The check is C4's hunt (`c4-schedules.ts:198-270`) run against it, with 200 schedules, 4 ticks and kills aimed at the holder of the work.

**Not run, by this finding or by the spike.**
- Linux and macOS (the spike's every number is from Windows 11), Postgres 16 and 17 (this was 18.6), and a real shared server. Only `pnpm check:external` ran against a second embedded server (README:237,355).
- A pooler in transaction mode, and `LISTEN/NOTIFY` turned on (surprise 12).
- C2 with pg-boss's default passes of 60 s, or with `JOBS`'s 30 s (README:357).
- A replica that is stalled but alive and wakes after losing its jobs (no `SIGSTOP` on Windows).
- A real GitHub under C2's lookup (spike 4).
- C3 under other loads: more keys, a skewed key distribution, more replicas. The overshoot in the table is probabilistic, and passes in which the handlers never exceeded 2 are evidence, and not a bound (README:358).
- C4 with the fix at 10 replicas or under a loaded database, where the 10 s dedupe margin is thinnest. A kill inside a forwarding batch with 3 survivors (README:354,356).
- C1 on DBOS. The docs list `enqueueInTransaction`, "Similar to enqueue, but performs the enqueue write inside a caller-owned transaction instead of in its own transaction" ([client](https://docs.dbos.dev/typescript/reference/client)), but no scenario ran it (README:115).
- DBOS on a fresh install without the one-time `DBOS.migrate`, and the sweeper that a dead executor with a new ID would need (README:112).
- Dead-letter queues and retention, `@pg-boss/dashboard`, the request budgets, a rolling upgrade with two pg-boss versions on one schema (ADR 0022), and the 1,000-task load test (F-117) (README:356).

**To settle, because the working tree and the run may differ.** If the maintainer wants the run proven against the committed code, rerun `pnpm spike` after the spike's files are committed (the risk in Method).

**Decisions the spike can't make:** the scheduler tick design and what an automation does for a missed occurrence (section 4, F-106), whether `groupConcurrency` may guard anything stronger than a throttle (item 4 of F-068 says no; the source's give-back is a timing argument, and the runs support it without proving it), whether the `web` role waits for the core, whether the server checks the database's time zone, and whether `@dbos-inc/dbos-sdk` stays in the spike.
