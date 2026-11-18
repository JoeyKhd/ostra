# Spike 8: `durable-queue-choice`

Throwaway code for milestone 0 (`context/build-order.md`). Its finding goes into `context/research/` only after real runs; nothing is written there yet.

## The question

**Does pg-boss cover ostra's background work?**

**Tests the decisions:** Q24 and ADR 0037 (background work on pg-boss, behind one package), with ADR 0017 (Postgres only), ADR 0016 (the panel enqueues, the core service works) and ADR 0011 (nothing is acted on before it's saved).

**Passes when** (copied from the build order):

- A job enqueued inside a Prisma 7 transaction exists only if the transaction commits.
- `kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate.
- A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief overshoot is recorded.
- 200 schedules created at runtime each fire once per tick while replicas restart.
- Delayed jobs survive a restart and can be cancelled.
- The panel process enqueues without running workers.
- It compiles under ostra's strict flags.

**If it fails:** run the failed scenario on DBOS and compare.

## Status, from the run on this machine on 2026-11-18

Machine: Windows 11, Node 24.14.0, pnpm 11.28.2, Postgres 18.6 (embedded-postgres), pg-boss 12.38.2, Prisma 7.10.1. Other spikes were running on the same machine during the runs, so the timings come from a loaded laptop. One consolidated `pnpm spike` run (18:58 to 19:21 UTC, about 23 minutes) gave **6 of 7 PASS and 1 FAIL (C4), nothing skipped; the exit code was 1**. A review of the first version of this spike found that its C4 never hit the window that matters, and its C2 and C3 were weaker than they looked; C2, C3 and C4 were rebuilt, and C4 now fails. The table is that run; the follow-up (the fallback on DBOS, the root causes, a fix, and a recommendation) is below it:

| # | Pass-bar bullet | Status | What the run showed |
|---|---|---|---|
| C1 | A job enqueued inside a Prisma 7 transaction exists only if the transaction commits. | **PASS** | Rolled back: no job, no task row. Committed: both, and a replica ran it. Held open: invisible to other connections and to polling workers until commit. Panel killed with `kill -9` mid-transaction: nothing. Control without `fromPrisma(tx)`: the job survives the rollback. New: a job under a fixed key sent twice is one job on an exclusive queue (the second send is `deduplicated`), two jobs on a standard queue (control), and a new job once the first has completed. |
| C2 | `kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate. | **PASS** | Three kill points, 6 jobs each: after the effect was recorded (all 6 re-ran on the other replica 15.3 s later; 6 POSTs for 6 keys; control with no lookup: 12 POSTs), **in the check-then-POST gap** (the fake had counted all 6 POSTs and held the responses, the victim had recorded 0 `created` rows; the retries found the pull requests by branch; 6 POSTs; control: 12), and **before the effect** (the fake held 6 uncounted requests and dropped them when the client died; the retries created them; 6 POSTs). |
| C3 | A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief overshoot is recorded. | **PASS (overshoot: peak 7 at limit 2, longest 50 ms in the job table; handlers peaked at 2)** | Short pass, 1,000 jobs of 40 to 100 ms: all ran once in 12.1 s; the job table showed a group above 2 in 0.68% of 48,695 snapshots, peak 6, longest episode 50 ms. **Long pass, 200 jobs of 2 to 4 s:** peak 7, longest episode 49 ms (0.35% of 55,944 snapshots). In both passes the handlers' own start and end records never showed more than 2 running in a group. |
| C4 | 200 schedules created at runtime each fire once per tick while replicas restart. | **FAIL** | 5 kills landed while a schedule-forwarding batch was active; 3 stranded it (150 occurrences held `active` by a dead replica). **128 of 800 (schedule, tick) pairs did not fire in their tick**: they fired 15.3 to 17.3 minutes late, when pg-boss expired the stranded batch and replayed it, and **22 occurrences fired a second time** by that replay. The other 672 pairs fired once, and the warm-up fires stayed within each schedule's occurrences. The first version of this scenario passed in each of three runs (2,400 pairs), because its kills never landed in a batch. |
| C5 | Delayed jobs survive a restart and can be cancelled. | **PASS** | Jobs due in 45 s ran once, 0.3 s after falling due, after `kill -9` of every replica and a graceful restart. A job that fell due with no replica alive ran 0.4 s after the restart began. Three cancellations (replicas up, all dead, after the restart): none ran. |
| C6 | The panel process enqueues without running workers. | **PASS** | With no replica alive the panel's job waited 6 s untouched. Registry row: no supervise, no schedule, no migrate, 0 workers. The panel exited by itself 27 ms after `stop()`. New: a panel started against a database with no pgboss schema fails to start (`Error: pg-boss is not installed`) and creates nothing. |
| C7 | It compiles under ostra's strict flags. | **PASS** | `tsc 5.9.3 --noEmit` exits 0 with all 8 flags set, over pg-boss's types and the generated Prisma 7 client. A syntax-tree scan of the 25 source files finds no `as` but `as const`, no `!`, no `any`, no enum, interface, class, default export or sync API. The repo root's ESLint rules (strict-type-checked, stylistic-type-checked, the repo's own) report 0 problems. |

**C4 failed, so the build order's fallback was run: C4 and C3 on DBOS Transact (D4 and D3), in the same harness, on the same embedded Postgres, with the same kill pattern.** The root cause of C4 was found in pg-boss's source, and a configuration change closes it: with that change C4 passed in every run. See the next section for the side-by-side results, the root causes and the recommendation. Short version: **keep pg-boss** (ADR 0037), and drive schedules from ostra's own table with a key per occurrence; the configuration fix is the stopgap, not the design.

## C4 and C3 on DBOS, and the root causes (2026-11-18, 19:51 to 21:29 UTC)

Same machine and load as above, plus `@dbos-inc/dbos-sdk` 5.6.0 (MIT core only: no Conductor, no Enterprise package). Every run below is a `pnpm spike` run with `SPIKE_ONLY` set; the raw results are in `.runs/<stamp>/results.json` (gitignored). "Fix" means `SPIKE_SEND_IT_HEARTBEAT_SECONDS=10 SPIKE_SCHEDULE_GUARD=all`.

### Results side by side

**C4 / D4: 200 runtime schedules, 4 ticks (800 (schedule, tick) pairs), three replicas, one graceful restart, and the hunt** (kill every replica but one the moment the library's in-flight window is visible; restart them):

| Run (UTC start) | Library and configuration | Verdict | Pairs exact / missed / doubled | Kills in the window, of them stranding | Stranded work came back after | Fire latency after the tick (p50 / max) |
|---|---|---|---|---|---|---|
| 18:58 (recorded above) | pg-boss, defaults | **FAIL** | 672 / 128 / 0, plus 22 occurrences fired twice by the replay | 5, 3 | 15.3 to 17.3 min (the 900 s expiry) | 4.3 to 16.9 s / 21.9 s |
| 19:22 (experiment above) | pg-boss, forwarding expiry 30 s, half guarded | **FAIL** | 800 / 0 / 0, but 5 plain schedules fired 3 times in a 2-occurrence warm-up | 3, 3 | about 1 min | 46.8 s max |
| 20:52 | pg-boss, defaults (a second run) | **FAIL** | 750 / 50 / 0, plus 62 occurrences fired twice by the replay (guarded ones too: the replay came 15 minutes later, in another slot) | 3, 3 | 902 to 906 s; 88 occurrences delivered 15.1 to 17.1 min late | 8.6 s / 12.9 s |
| 20:46 | pg-boss, heartbeat 10 s only (half guarded) | **FAIL** | 798 / 0 / 2 (both plain), and 3 plain schedules fired 3 times in a 2-occurrence warm-up; guarded 400 / 400 | 4, 3 | 13.4 to 18.5 s | 19.1 s / 29.1 s |
| 19:53 (3 ticks) | pg-boss, **fix** | **PASS** (2 of 3 target strands) | 600 / 0 / 0 | 5, 2 | 13.5, 18.4 s | 29.8 s / 44.7 s |
| 20:04 | pg-boss, **fix** | **PASS** | 800 / 0 / 0 | 5, 3 | 13.5 to 18.5 s | 8.2 s / 21.6 s |
| 20:18 | pg-boss, **fix** | **PASS** | 800 / 0 / 0 | 4, 3 | 13.4 to 18.6 s | 20.9 s / 35.9 s |
| 20:32 | pg-boss, **fix** | **PASS** | 800 / 0 / 0 | 3, 3 | 13.4 to 18.5 s | 21.8 s / 36.9 s |
| 19:53 (3 ticks) | DBOS, stable executor ID per slot | FAIL, harness (see below); 600 / 600 exact | 600 / 0 / 0 | 3, 3 (all 200 fires of a tick each) | on the restart, all 600 | 0.01 s / 0.86 s |
| 20:04 | DBOS, stable executor ID | FAIL, harness; 800 / 800 exact | 800 / 0 / 0 | 4, 3 | on the restart, all 600 | 0.01 s / 1.85 s |
| 20:18 | DBOS, stable executor ID | FAIL, harness; 800 / 800 exact | 800 / 0 / 0 | 3, 3 | on the restart, all 600 | 0.01 s / 0.91 s |
| 20:32 | DBOS, stable executor ID | **PASS** (2 of 3 target strands) | 800 / 0 / 0 | 4, 2 | on the restart, all 400 | 0.01 s / 0.95 s |
| 21:18 | DBOS, stable executor ID | **PASS** | 800 / 0 / 0 | 4, 3 | on the restart, all 600 | 0.01 s / 1.15 s |
| 21:24 | DBOS, stable executor ID | **PASS** | 800 / 0 / 0 | 3, 3 | on the restart, all 600 | 0.01 s / 0.81 s |
| 20:52 | DBOS, **a new executor ID per process** | **FAIL** | 400 / 400 / 0 | 5, 2 (and the tick-edge strike) | **never**: the 400 stayed `PENDING` under the dead executor IDs | 0.85 s / 0.85 s |

The three DBOS "FAIL, harness" runs met the criterion (every pair exactly once) and failed an extra check D4 adds, "no fire created after the run". Each of them had exactly 200 such fires: the tick that came due 10 s after the schedules were deleted. DBOS's scheduler rereads its schedule table only every `schedulerPollingIntervalMs` (30 s by default, `scheduler.js`), so **a deleted DBOS schedule can fire once more for up to 30 s**. The 19:53 run's check counted every fire after the run; the 20:04 and 20:18 runs had a split meant to set that tick apart, but its regex had lost its escapes and matched nothing. The fixed check reads the tick from the workflow ID (`sched-<name>-<tick ISO>`) and fails on any fire of an in-run tick created after the run; it was not loosened in any other way. The 20:32, 21:18 and 21:24 runs used the fixed check, and passed it. The criterion's own numbers above are unaffected.

In every DBOS run one replica claimed a whole tick's 200 fires at once, so each stranding strike stranded 200; the hunt's tick-edge strike (every replica but one killed 5 ms after a tick, while the leader enqueues it) never lost a tick.

**C3 / D3: a limit of 2 per key, three replicas x 16 workers, 1,000 jobs of 40 to 100 ms and 200 of 2 to 4 s on 20 keys.** All passes ran every job once, none retried. Peaks are per group; "committed" is the back-to-back poll of the running count (pg-boss `active`, DBOS `PENDING`), the primary measure:

| Run | Library | Verdict | Committed peak, short / long | Snapshots above 2, short / long | Longest committed episode | Table-timestamp peak | Handler peak | Throughput, short pass |
|---|---|---|---|---|---|---|---|---|
| 18:58 (above) | pg-boss | PASS, overshoot | 6 / 7 | 0.68% / 0.35% | 50 ms | (not split) | 2 | 82.6 jobs/s |
| 20:04 | pg-boss | PASS, overshoot | 4 / 4 | 0.53% / 0.13% | 20 ms | 3 | 2 | 85.9 jobs/s |
| 20:18 | pg-boss | PASS, overshoot | 6 / 4 | 0.82% / 0.38% | 58 ms | 3 | 2 | 81.6 jobs/s |
| 20:32 | pg-boss | PASS, overshoot | 7 / 4 | 0.75% / 0.33% | 54 ms | 3 | 2 | 85.7 jobs/s |
| 20:04 | DBOS | PASS, "overshoot" | **2 / 2** | **0% / 0%** | **0 ms** | 3 (0.0 ms long: a tie, see below) | 2 | 69.1 jobs/s |
| 20:18 | DBOS | PASS, "overshoot" | **2 / 2** | **0% / 0%** | **0 ms** | 3 (0.0 ms) | 2 | 67.2 jobs/s |
| 20:32 | DBOS | PASS, "overshoot" | **2 / 2** | **0% / 0%** | **0 ms** | 3 (0.0 ms) | 2 | 71.5 jobs/s |

DBOS's "overshoot" is the harness, not DBOS: its table stores whole milliseconds, a job that starts in the millisecond its predecessor ended ties with it, and the sweep orders a start before an end at the same instant on purpose ("can only overstate"), so the table view reads 3 for 0.0 ms. The committed snapshots (about 42,000 to 52,000 a pass) never saw a third running workflow. The check was left as it is.

### Root cause: C4 on pg-boss

A pg-boss limitation in how it fires schedules, closed by configuration. Two defects together, both in `node_modules/pg-boss/dist/timekeeper.js` and `plans.js` (12.38.2):

1. **A dead holder strands a forwarding batch for 15 minutes.** The cron pass does not create the jobs: it inserts each due occurrence into an internal queue, `__pgboss__send-it`, and every replica works that queue 50 at a time (`timekeeper.start`: `createQueue(QUEUES.SEND_IT)` with no options, `work(..., { batchSize: 50 })`). With no options the queue has no heartbeat and pg-boss's default expiry of 900 s (`QUEUE_DEFAULTS.expire_seconds`, plans.js). A replica killed while it holds a batch leaves 50 occurrences `active`; nothing notices until `failJobsByTimeout` expires them 15 minutes later and they are retried. So the occurrences miss their tick and fire 15 minutes late.
2. **The replay sends again what was already sent.** `onSendIt` sends the batch's real jobs in parallel (`Promise.allSettled(jobs.map(... this.manager.send(...)))`), each in its own statement, so when the holder dies some of the 50 jobs exist and the forwarding job is still `active`. The retry sends all 50 again. The occurrence's own slot does not reach the real job (`const { key, slot, ...request } = data` strips it), so the only thing that can drop the second send is the schedule's own options: a singleton key with `singletonSeconds: 60` dedupes it against the first (unique index `job_i4` on `(name, singleton_on, singleton_key)`, which counts completed jobs too), **provided the replay lands in the same 60 s slot**, because that slot is computed from the replay's own clock (`insertJobs`, the `singletonSeconds` branch of `singleton_on`). A plain schedule fires twice.

It is not the harness: the hunt kills a replica holding a batch, which is what "while replicas restart" means, and the earlier version that never hit the window passed for that reason. It is not ostra's configuration alone either: the forwarding queue is internal and created by pg-boss without options.

**The configuration fix, shown above (4 of 4 runs PASS, 3,000 of 3,000 pairs, 11 stranded batches):**

- **Part 1: a heartbeat on the forwarding queue.** pg-boss 12.38.2 accepts `heartbeatSeconds` in `updateQueue` (`UpdateQueueOptions` re-adds it; the plan sets `heartbeat_seconds`), and a job takes its queue's heartbeat when inserted (`COALESCE("heartbeatSeconds", q.heartbeat_seconds)`). Each core replica calls `updateQueue("__pgboss__send-it", { heartbeatSeconds: 10 })` after `start()` (`jobs.setForwardingHeartbeat`). A stranded batch then fails on `failJobsByHeartbeat` and is replayed: **13.4 to 18.6 s after the kill in every run** (10 s heartbeat, the 5 s supervise pass, the 5 s forwarding poll), instead of 15 minutes.
- **Part 2: every schedule carries a singleton key (its own key) and `singletonSeconds: 60`** (`SPIKE_SCHEDULE_GUARD=all`). The replay's second sends are then dropped in the same minute. Part 1 alone is not enough: the 20:46 run had 2 plain pairs fire twice and 3 plain schedules over-fire in the warm-up, while the 400 guarded pairs of the same run were exact.

**What the fix does not guarantee.** Part 2 is a timing argument. A replay dedupes only if it lands in the same minute as the first send; the first send comes up to 30 s after the tick (the cron pass runs every 30 s) plus the 5 s forwarding poll, and the replay adds 13 to 19 s, so the margin is about 10 s. The runs' latest fire was 44.7 s after its tick. A replay that crosses the minute is filed in the next slot, where it either collides with the next tick's fire and drops it, or fires and the next tick's fire is dropped: one tick missed, the next on time. A loaded database that delays the forwarding poll, or a longer heartbeat, eats the margin. And the fix reaches into pg-boss internals (the queue name `__pgboss__send-it` and its options are not a documented API), so a pg-boss upgrade can undo it silently. Occurrences inserted before the first replica's `updateQueue` (the first seconds of a fresh install) carry no heartbeat.

### Root cause: C3's overshoot on pg-boss

A pg-boss design choice, not a failure, and not a harness bug, though it is the harness's primary measure that shows it. `groupConcurrency` is enforced optimistically (`manager.js`, `#fetch` and `#giveBack`; `plans.js`, `fetchNextJob`):

- the claim (`UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`) reads the group's `active` count from a materialized CTE in the statement's own snapshot, under READ COMMITTED. 48 worker loops (3 replicas x 16) claim concurrently, and none sees a racing claim that has not committed, so several can each admit a job into a group that is already at 2;
- after its own commit, each fetch recounts the group (`getActiveGroupCounts`) and gives its excess back to `created` (`restore`) before any handler starts. Of two racing fetches the later recount always sees both: each commits before it recounts, so if A recounts before B commits, B's recount comes after A's commit;
- so the committed table shows a group above the limit for the milliseconds between a claim's commit and its give-back, which the back-to-back sampler catches (peaks 4 to 7, episodes up to 58 ms, 0.1 to 0.8% of snapshots), and the handlers never run more than 2 (peak 2 in every pass of every run).

No configuration removes it: `groupConcurrency: 1` uses a `NOT EXISTS` probe in the same snapshot, and fewer worker loops only shrink the race. It costs nothing while handlers never overrun, but it is an argument from statement ordering, not a lock, so a hard budget still lives in ostra's own rows (ADR 0037). DBOS does the opposite (`system_database.js`, `claimStartableWorkflows`): a claim on a partitioned queue takes `pg_try_advisory_xact_lock` on the (queue, partition) pair, counts `PENDING` inside that transaction and claims only the room left, so claims of one partition are serialized and the committed state never exceeded 2. A claimer that misses the lock claims nothing until its next poll, which is part of why DBOS's short pass ran at 67 to 72 jobs/s against pg-boss's 82 to 86.

### What DBOS showed besides

- **Its scheduler is the stronger design.** One replica holds a background lock (a transaction-scoped advisory lock, retaken every 60 s, freed by Postgres when its connection dies) and fires; each tick's workflow ID is fixed (`sched-<schedule>-<tick ISO>`, `enqueueTicks`), inserted with the rest of the tick in one transaction that also stamps `last_fired_at`, and an existing ID is skipped. A standby keeps a tick until a poll shows it fired. So a replay, a second leader or a backfill cannot fire a tick twice, whatever the timing. Fires were created 0.01 s after the tick (p50), against pg-boss's 8 to 30 s.
- **Recovery hangs on the executor ID.** A killed replica's claimed fires stay `PENDING` until a process launches under the same executor ID (`DBOS.launch` recovers only its own ID, `recoverPendingWorkflows`); there is no heartbeat on a claim in the MIT core. With a stable ID per slot the restarted replica recovered every stranded fire. With a new executor ID per process (the 20:52 run, `SPIKE_DBOS_EXECUTOR_ID=process`, as a pod with a generated name would get) the stranded fires were never recovered: 400 of 800 pairs missed, all 400 still `PENDING` under their dead executors at the end. Without Conductor, ostra would need the sweeper that `research/durable-execution.md` describes (a replica table, a dead-replica check, `DBOS.recoverWorkflows([id])`), and it must never recover a live executor.
- **Three replicas launching on a cold database deadlock.** The first D3 run failed one replica's `DBOS.launch` with `deadlock detected` in DBOS's migrations. D3 and D4 now run `DBOS.migrate(url)` once before the replicas start (`migrateDbos`), as an install step would. pg-boss's concurrent install never failed in this spike.
- **A deleted schedule fires for up to 30 s more** (above).
- The panel side worked as hoped: `DBOSClient` created 200 schedules in 0.2 s and enqueued 1,000 workflows without launching DBOS, and DBOS's schema shared the scenario database with ostra's tables and pg-boss's. Transactional enqueue from Prisma (C1 on DBOS) was not run.

### Recommendation

**Keep pg-boss (ADR 0037). Do not use pg-boss's cron for anything whose duplicate or lateness costs something; drive those schedules from ostra's own table, with a key per occurrence.** Concretely, for automations (F-106) and every other schedule that starts work:

1. ostra's `automation` row holds the cron expression (Q10: schedules stored in the database, created at runtime).
2. One pg-boss job per minute, the **scheduler tick**, finds the due occurrences. A single scheduler lease (a lease row or `pg_try_advisory_xact_lock`, as DBOS does) keeps the replicas from duplicating the work, but correctness does not rest on it.
3. Each occurrence is a row, `automation_run (automation_id, occurrence_at)` with a unique key, inserted `ON CONFLICT DO NOTHING` in the same transaction as its job (`enqueueInTx`, C1), and the job's key is `automation:<AutomationId>:<occurrence ISO>`. A replayed tick, a second scheduler or a backfill finds the row and does nothing. This is DBOS's deterministic workflow ID rebuilt on ostra's tables, and it is ADR 0037's rule 1 (the tables are the truth) and rule 2 (fixed keys) applied to schedules; missed occurrences are found from `last_fired_at` the way DBOS's standby finds them.
4. Keep the configuration fix as defence in depth wherever pg-boss's own `schedule()` stays in use (the scheduler tick itself, reconciliation per board, insights, the model-catalog refresh): heartbeat 10 s on `__pgboss__send-it`, and a singleton key plus `singletonSeconds` equal to the cron's period on every schedule. For those jobs a late or repeated run costs one idempotent pass (rule 1). Pin the pg-boss version, and add a boot check that the forwarding queue carries the heartbeat, since it is an internal queue.

**Weighed against the alternatives and ADR 0037's reasons:**

- **DBOS for schedules only: no.** It would bring a second durable-execution system, a second schema and its migrations, stable executor IDs on every replica (or ostra's own sweeper), and DBOS's lifecycle in every core process, to replace one table and one keyed job. Its scheduler is better than pg-boss's, but the property that makes it better (a fixed ID per tick, inserted atomically) is the part ostra can rebuild in a few dozen lines on the tables it already has.
- **DBOS for everything: no, and the spike adds to ADR 0037's reasons rather than overturning them.** ADR 0037 said a dead replica needs a sweeper with DBOS and not with pg-boss: D4 confirmed it (a killed replica's fires are recovered only by its own executor ID; pg-boss's heartbeats freed every stranded batch in 13 to 19 s once the queue had one, and C2 already showed it for jobs). ADR 0037 said the three rules leave DBOS's durable workflows little to do: D3 and D4 used DBOS only as a queue and a scheduler, and the one thing it did better in C3 (a limit that never shows in the table) is a guarantee ostra already keeps in its own rows. The open-core concern is unchanged. What DBOS did better (exact partition limits, a scheduler that cannot double-fire, sub-second fires) is real and worth copying, which point 3 does.
- **Revisit DBOS** if ostra ever needs durable multi-step workflows that its state machine cannot express, or if pg-boss changes its forwarding queue in a way the boot check catches.

## What was built

```
src/jobs.ts            THE SEAM. The only file that imports pg-boss (ADR 0037, Q78). Typed job
                       definitions (Zod payloads), enqueueInTx / enqueueManyInTx over fromPrisma(tx),
                       worker registration, schedules, cancel. In ostra this becomes packages/jobs.
src/job-defs.ts        The job catalog: task-transition (an exclusive queue, keyed), task-timeout, github-effect,
                       group-work, schedule-fire.
src/payloads.ts        Every job payload as a Zod schema, written once (job-defs and the harness messages import it).
src/ids.ts             One branded type per ID (TaskId, JobId, ReplicaId, PanelId, GroupKey, BoardId, EffectKey),
                       the task-state union and the fixed job key `task:<TaskId>:<transition>:<seq>`.
src/handlers.ts        What a replica does with each job. Each one re-checks its tables first.
src/code-host.ts       The two calls a handler makes to the code host: find a pull request by its branch, create it.
src/replica.ts         A "core" replica, run as a child process: migrates, supervises, runs the schedule
                       pass, works queues. The harness spawns two or three over one Postgres.
src/panel.ts           The "panel", also a child process: a pg-boss producer that enqueues inside its own
                       Prisma transactions and never works, supervises, schedules or migrates.
src/fake-github.ts     A local fake GitHub with GitHub-shaped pull request endpoints. It counts Idempotency-Key
                       headers per key, and can hold a request before or after counting it (C2b, C2c).
src/cluster.ts         embedded-postgres (a real Postgres 18 server) or SPIKE_DATABASE_URL; one database per
                       scenario, cloned from a template that holds ostra's Prisma tables. Every database carries
                       the run's suffix and is dropped when the cluster stops, on a failed start too.
src/child-env.ts       The allowlisted environment every child process (replica, panel, prisma, tsc, eslint) gets.
src/external-check.ts  `pnpm check:external`: the SPIKE_DATABASE_URL path against a real server (see below).
eslint.config.mjs      The repo root's lint rules applied to this spike (the root config ignores spikes/**); C7 runs it.
src/harness.ts         `pnpm spike`. src/scenarios/c1 .. c7 are the criteria; src/observations.ts holds
                       side facts that are not criteria.
prisma/                ostra-style tables owned by Prisma Migrate. pg-boss keeps its own `pgboss` schema.

src/scenarios/schedule-judge.ts  How a schedule run is judged (fires per tick, warm-up, late fires),
                       shared by C4 and D4 so both libraries meet the same rules.
src/dbos/              The build order's fallback: C3 and C4 on DBOS Transact, in the same harness.
  jobs.ts              THE DBOS SEAM. The only file that imports @dbos-inc/dbos-sdk (lint rule and C7 scan).
                       Two workflows, a partitioned queue, runtime schedules, a producer client.
  replica.ts           A DBOS core replica, the twin of src/replica.ts: same IPC messages, same rows written.
  messages.ts          Its config schema (strict).
  d3-group-limit.ts    D3: C3's two passes and three measures (src/scenarios/c3-group-limit.ts, runGroupLimit),
                       on a queue with partitionConcurrency 2.
  d4-schedules.ts      D4: C4's 200 schedules, hunt and judging, on DBOS's scheduler.
```

The harness spawns replicas and the panel with `node src/replica.ts` (Node 24 type stripping, no tsx). They talk to the harness over a Zod-validated IPC channel. `kill -9` is `child.kill("SIGKILL")`, which on Windows is `TerminateProcess`: no handler runs and no socket is closed politely.

```
harness ──spawn──▶ replica-1 ─┐
        ──spawn──▶ replica-2 ─┼──▶ one Postgres (pg-boss schema + ostra tables)
        ──spawn──▶ replica-3 ─┤
        ──spawn──▶ panel ─────┘   (enqueues in Prisma transactions, no workers)
        ◀── HTTP ── fake GitHub (counts Idempotency-Keys)
```

## How to run

```
pnpm install
pnpm check:inputs      # which inputs are present; never prints a value
pnpm typecheck         # prisma generate, then tsc --noEmit under ostra's strict flags
pnpm spike             # every criterion and D3, D4: about 16 minutes with no stranded batch, about 32 when C4 strands one (it then waits out pg-boss's 15-minute expiry)
pnpm check:external    # the SPIKE_DATABASE_URL path against a real server, about 40 s
```

A subset or a shorter C4, in the two shells this machine has:

| | Git Bash / POSIX | PowerShell |
|---|---|---|
| C1 and C3 only | `SPIKE_ONLY=C1,C3 pnpm spike` | `$env:SPIKE_ONLY="C1,C3"; pnpm spike` |
| a shorter C4 | `SPIKE_SCHEDULE_TICKS=2 SPIKE_ONLY=C4 pnpm spike` | `$env:SPIKE_SCHEDULE_TICKS="2"; $env:SPIKE_ONLY="C4"; pnpm spike` |
| C4 with the fix, and D3, D4 | `SPIKE_SEND_IT_HEARTBEAT_SECONDS=10 SPIKE_SCHEDULE_GUARD=all SPIKE_ONLY=C3,D3,C4,D4 pnpm spike` | `$env:SPIKE_SEND_IT_HEARTBEAT_SECONDS="10"; $env:SPIKE_SCHEDULE_GUARD="all"; $env:SPIKE_ONLY="C3,D3,C4,D4"; pnpm spike` |
| a shared Postgres server | `SPIKE_DATABASE_URL=postgresql://... pnpm spike` | `$env:SPIKE_DATABASE_URL="postgresql://..."; pnpm spike` |

(In PowerShell the variables stay set for the session: `Remove-Item Env:SPIKE_ONLY` clears one.)

Exit code: 0 only when every selected scenario is PASS. A SKIPPED scenario (no Postgres could be started) or an unknown id in `SPIKE_ONLY` is not green.

Other knobs (all optional, each with a default):

| Variable | Default | Effect |
|---|---|---|
| `SPIKE_ONLY` | all | comma-separated ids: C1 to C7, D3 and D4 (DBOS), and O1 for the observation |
| `SPIKE_DATABASE_URL` | embedded-postgres | a Postgres server to use instead; needs CREATE and DROP DATABASE. A generic `DATABASE_URL` in your shell is ignored on purpose |
| `SPIKE_RUN_ID` | random | 8 hex digits suffixed to every database the run creates |
| `SPIKE_SCHEDULE_COUNT` / `SPIKE_SCHEDULE_TICKS` | 200 / 4 | C4: schedules and whole minutes |
| `SPIKE_SCHEDULE_HUNT_KILLS` | 3 | C4: strikes that must strand a forwarding batch (the hunt tries at most 3 times that many) |
| `SPIKE_STRAND_WAIT_MINUTES` | 17 | C4: how long to wait for a stranded forwarding batch (only if one happened) |
| `SPIKE_SEND_IT_EXPIRE_SECONDS` | unset (pg-boss's 900) | C4 experiment: the expiry set on pg-boss's forwarding queue by every replica |
| `SPIKE_SEND_IT_HEARTBEAT_SECONDS` | unset (no heartbeat, pg-boss's default) | C4 fix, part 1: the heartbeat every replica sets on pg-boss's forwarding queue (`updateQueue`; at least 10) |
| `SPIKE_SCHEDULE_GUARD` | `alternate` | C4 fix, part 2: `all` gives every schedule a singleton key and a 60 s slot; `alternate` only every second one |
| `SPIKE_DBOS_EXECUTOR_ID` | `slot` | D4: `slot` restarts a killed DBOS replica under its slot's executor ID; `process` gives each process a new one |
| `SPIKE_GROUP_JOBS` / `SPIKE_GROUP_KEYS` | 1000 / 20 | C3: the short pass |
| `SPIKE_GROUP_LONG_JOBS` | 200 | C3: the pass with 2 to 4 s jobs |
| `SPIKE_GROUP_PEAK_CAP` | 10 | C3: a peak above this fails |
| `SPIKE_KEEP_LOGS` | unset | `1` keeps `.runs/<stamp>/` logs of a green run (a red or skipped run keeps them anyway) |

Run one harness at a time per directory (a lock file, `.data/harness.pid`, is removed on every exit path). An interrupted run leaves a data directory under `.data/`, which the next run removes.

### Inputs each criterion needs

| Criterion | Needs | On this machine |
|---|---|---|
| C1 to C6 | a Postgres server that allows `CREATE DATABASE`: embedded-postgres (installed by `pnpm install`) or `SPIKE_DATABASE_URL` | embedded-postgres 18.6, present |
| C7 | nothing for tsc and the syntax scan; the repo root's `pnpm install` for the ESLint part | present |
| none | a model key, GitHub, Linear | not used: the pass bar's GitHub is a local fake |

On Windows, `postgres.exe` cannot open paths of 260 characters or more, so the checkout path must stay short (this one uses 219 of 259; `pnpm check:inputs` reports it). A scratch checkout under a deep temp directory failed with "could not stat file ... plpgsql--1.0.sql" until it was moved to a short path.

**`SPIKE_DATABASE_URL` is exercised**, by `pnpm check:external`: it starts its own embedded server in `.data-external/` and runs the harness against it. Its four checks passed on 2026-11-18: a run of C6 on the server leaves no database behind; a second run on the same server works (the first run's `spike_<run>_*` names do not collide); a start that fails (the template's name is taken) exits 1 after 1 s, leaves the pre-existing database untouched and nothing else, and does not hang; a generic `DATABASE_URL` pointing nowhere is ignored. Not tested: a server where the role lacks `CREATE DATABASE` (the harness then reports the server's error and exits 1), PgBouncer, a server older than Postgres 13 (`DROP DATABASE ... WITH (FORCE)` needs 13).

`embedded-postgres` is spike-only. `packages/jobs` CI uses a Postgres service container unless the maintainer says otherwise.

## How each criterion was judged

Every scenario starts a fresh database and fresh child processes. A PASS is printed only when the scenario's own assertions hold; a scenario that throws is a FAIL, and one with no Postgres is SKIPPED with the missing input named.

### C1. Transactional enqueue

`prisma.$transaction(tx => { tx.task.create(...); jobs.enqueueInTx(tx, ...) })`, where `enqueueInTx` calls `boss.send(queue, data, { db: fromPrisma(tx) })` (pg-boss's Prisma adapter, over `tx.$queryRawUnsafe`). Cases A to D through the panel process, then a control (E), then three on the fixed job key (F to H). The control matters: sending on pg-boss's own pool inside the same Prisma transaction leaves the job behind when the transaction rolls back, so `db: fromPrisma(tx)` is what ties the two together. Notes for ostra:

- `send()` still looks the queue up through pg-boss's own pool (its queue cache), so a producer needs its own small pool, and the queue must already exist. The core service creates the queues at boot (`installQueues`).
- The panel starts pg-boss with `migrate: false`, `supervise: false`, `schedule: false`. pg-boss then only checks the schema version on start. **Started against a database where no core has run, that check fails**: C6's step 0 recorded `Error: pg-boss is not installed`, and the panel process exits. So the panel does not "boot before the core" (ADR 0016) without help: it must retry its start, or wait for the core's migration, or the install must run the core first.
- **A fixed job key (ADR 0037, rule 2) needs a queue policy.** `singletonKey` alone does nothing on a `standard` queue (G, the control: two jobs for one key). On a queue created with `policy: "exclusive"` (one job per key while it is queued, waiting to retry or running) the second send returns no id, which `enqueueInTx` reports as `{ kind: "deduplicated" }` (F). The task-transition queue is exclusive, and every job on an exclusive queue must carry a key. Once the first job has completed the key is free again: the same key made a new job (H), and the handler's own state check (rule 1) is what made that harmless. `send()` returns null on a duplicate: it does not hand back the existing job's id.

### C2. `kill -9` mid-job

Two replicas, six jobs. Each handler looks the pull request up by its branch (`GET /repos/<owner>/<repo>/pulls?head=<owner>:ostra/<key>`, the call the real adapter will make), creates it if it is not there (`POST` with an `Idempotency-Key`), and records a `job_run` row at each step. The replica holding the most jobs gets SIGKILL. pg-boss's heartbeat (`heartbeatSeconds: 10`, refreshed every 5 s) goes stale, the other replica's supervise pass fails the jobs into retry, and that replica runs them again. Three kill points, each its own run:

- **C2, after the effect.** The kill comes once all six POSTs are counted and recorded, while the jobs keep working for 30 s. The retried attempt finds the pull request and skips the call. The control (same kill, a handler with no lookup) makes 12 POSTs for 6 keys.
- **C2b, in the check-then-POST gap.** The fake accepts and counts the POST and then holds the response for 10 s (`x-hold-ms`). The kill comes while all six handlers wait for it, so the pull request exists and no handler has recorded `created`. The run asserts the landing (the fake had counted all six POSTs, the victim had written 0 `created` rows), that the retries found the effect by its branch, and 6 POSTs for 6 keys. The control (no lookup) duplicates, so the gap is real.
- **C2c, before the effect.** The fake holds each request for 10 s before counting it (`x-hold-before-ms`) and drops a request whose client died. The kill comes while it holds six; 0 POSTs are counted at that moment. The retried attempts find nothing and create the effect once: 6 POSTs for 6 keys.

Notes:

- Recovery took 14.9 to 15.5 s in the runs where the survivor had free workers (monitor and supervise passes set to 5 s; pg-boss's defaults are 60 s and were not measured). In the very first run the survivor had no free worker and the jobs waited 29.7 s for one, so replicas need headroom.
- In every run one replica took all six jobs at its first poll, so the survivor had none of its own. In an earlier run the split was 3 and 3, and the survivor's own jobs ran undisturbed.
- Delivery is at least once. No duplicate side effect comes from the queue; it comes from the handler, and the lookup by a marker the handler can recompute (the branch) is what prevents it (ADR 0037, "idempotency toward trackers", F-046).
- Not covered: a replica that is stalled but alive and wakes after its jobs were given away (`job.signal` aborts in that case, but there is no SIGSTOP on Windows), and a real GitHub (spike 4): the lookup is the call the real adapter will make, but only a real run can say how GitHub answers it right after a create.

### C3. A limit per key across replicas

Three replicas, 16 local workers each (48 workers for 40 slots), `groupConcurrency: 2`, jobs sent with `group: { id: key }`. Two passes: **short** (1,000 jobs of 40 to 100 ms on 20 keys, the pass bar's own load) and **long** (200 jobs of 2 to 4 s on 20 keys). The second pass exists because "brief" is true by construction for short jobs: an over-admitted job ends when its group's oldest active job finishes, and with 40 to 100 ms jobs that is at most 100 ms. Real ostra jobs call GitHub or Linear and last seconds. Concurrency is measured three ways:

1. **Committed state**, the primary measure: a dedicated connection polls the number of `active` jobs per group back to back (about 40,000 to 65,000 polls a pass) and holds each snapshot until the next.
2. The **job table's timestamps** (`started_on` to `completed_on`). These are statement-start times, so they understate.
3. The **handlers' own start and end events**.

"Holds" is judged with working values the spike set for itself (pg-boss promises no bound), set before the long pass existed:

- both passes: every job ran exactly once, and no snapshot shows more than 10 active jobs in one group (5 x the limit; `SPIKE_GROUP_PEAK_CAP`), a hard cap so the peak is never unbounded;
- short pass: keys spent at most 5% of their busy time above the limit, and no key stayed above it for 1 s or more at a stretch;
- long pass: the time above the limit and the longest episode are recorded and not bounded: if an over-admitted job were run, the episode would last as long as the shortest remaining job in the group, and a bound would only restate the job length.

The size of an overshoot is always reported, and **the summary line carries it whenever the peak went above the limit**: `PASS (overshoot: peak N at limit 2, longest X ms in the job table; handlers peaked at M)`. pg-boss's docs say concurrent fetches "can briefly exceed" the limit; what that means in practice is below. The limit is also an option of each `work()` call and is not stored in the database, so every replica must pass the same value.

**What the runs showed.** The reviewer's worry was that over-admission lasts as long as a job. In ten passes (five runs of the two-pass scenario) it did not: the longest table episode with 2 to 4 s jobs was 37, 48, 56, 49 and 54 ms, against 50 to 70 ms with 40 to 100 ms jobs, and the handlers never ran more than 2 at once. The last of the five was an extra run with 1,000 jobs of 2 to 4 s (`SPIKE_GROUP_LONG_JOBS=1000`, 77 s, 212,000 snapshots): peak 7, 12 overshoot episodes, 0.01% of busy key-time, handlers peaked at 2. The reason is in pg-boss's source (`manager.js`, `#fetch`): the fetch statement cannot see a racing claim until it commits, so it recounts the group after its own commit and gives the excess back to `created` before any handler starts ("of two racing fetches at least the later count sees both and gives back"). The extra rows are `active` in the table for tens of milliseconds and are never run. That is a stronger result than "a throttle": in these runs the limit held for running work across three replicas. It is still an argument from timing, not a proof (the recount belongs to the fetch, not to a transaction around the claim), so a spend that must never exceed a budget keeps its guarantee in ostra's own tables, as ADR 0037 says. The hard cap on the table's peak (10) was never near.

### C4. 200 runtime schedules

The panel creates 200 schedules at runtime (`* * * * *`, one per board). Half use pg-boss's default options (plain); half also set a singleton key and a 60 s slot on the jobs they create (guarded). Three replicas run the schedule pass and a worker that records every fired job.

**How pg-boss fires a schedule** (`timekeeper.js`, `plans.js`): every 30 s one replica's pass inserts each due occurrence into an internal queue, `__pgboss__send-it`. Every replica polls that queue every 5 s, fetches up to 50 occurrences, and creates the real job for each. That queue is created without options: no heartbeat, a 15-minute expiry, 2 retries. So a replica killed while it holds a batch leaves its occurrences `active` until the expiry, and then the whole batch is sent again.

**The hunt.** The first version of this scenario killed replicas "at tick + 0.3 s", which does not reach that window: a batch is `active` for tens of milliseconds a minute. Now a dedicated connection polls the forwarding queue back to back while occurrences wait, and the moment a batch is `active` the harness kills every replica but one (the survivor rotates; pg-boss does not say who holds a batch, so the holder is among the killed with probability 2/3). It reads the batch again 3 s later: still `active` means the holder was killed and the batch is stranded. Already-stranded jobs are never taken for a new batch, strikes are 25 s apart so each meets a different burst, and the hunt wants 3 strikes that strand a batch (at most 9 tries); fewer shows on the summary line. One graceful stop and restart runs at the first tick. After the last tick the schedules are removed, and if a batch is stranded the scenario waits up to 17 minutes for pg-boss to free it and counts what the replay does.

**Judged:** every one of the 200 schedules fired exactly once in every tick (a fire is one job pg-boss created; a handler that ran twice for the same job, after its replica was killed, is at-least-once delivery, C2's case); before the first tick a schedule fired no more often than it had occurrences (a new schedule fires once for an occurrence up to 60 s old, then once a minute); and a replayed batch made no second fire.

**Result (the recorded run).** Strikes at -76.5, -48.1, +11.8, +75.2 and +133.6 s from the first tick (the first two found the batch finished by the survivor 3 s later; the last three stranded 50 occurrences each, one batch in each of ticks 0, 1 and 2). Of the 150 stranded occurrences, 128 had not been sent and 22 had. pg-boss freed the batch 15 minutes after the strike and replayed it: the 128 fired 15.3 to 17.3 minutes after their tick (missed in time, delivered late), and the 22 fired a second time. Earlier runs of this scenario agree: with the first version of the hunter, whose strikes all landed in one burst, 100 stranded occurrences were replayed 610 s after the run's end and fired a second time; in a run where all three strikes met a batch a survivor held, nothing was stranded and the scenario passed (800 of 800, 3 kills landed, 0 stranded). So the failure needs the replica that holds a forwarding batch to die, which is exactly the "replicas restart" the pass bar names.

**C4 experiment: a 30 s expiry on the forwarding queue.** `SPIKE_SEND_IT_EXPIRE_SECONDS=30` makes each replica call `updateQueue("__pgboss__send-it", { expireInSeconds: 30 })` once it has started (this experiment assumed the queue's `heartbeatSeconds` could not be changed after creation; it can, see "C4 on DBOS, and the root causes" below). One run (`SPIKE_ONLY=C4`): 3 strikes, all three stranded a batch (150 occurrences: 100 from the warm-up, 50 in tick 0). pg-boss freed them within about a minute, replayed them, and **800 of 800 (schedule, tick) pairs fired exactly once, none late**. But **5 plain schedules fired three times in the warm-up window**, which had two occurrences (the replay repeated sends that had already gone through), and none of the 100 guarded schedules (singleton key and 60 s slot) did. The verdict was still FAIL, on those 5. One run is a lead and not a result: a replay that crosses a minute boundary lands in another slot, and the guard would not catch it.

Other C4 facts:

- A schedule created at runtime fires once for an occurrence up to 60 s old, on the first pass after it is created (400 warm-up fires in the recorded run, 2 per schedule). Expect that when an automation is created.
- Fires arrive late: p50 between 4.3 s and 16.9 s and at most 21.9 s after the tick across today's runs (46.8 s in the experiment, which replayed a batch), because the cron pass runs every 30 s and forwards occurrences through an internal queue polled every 5 s, so the delay depends on where the pass falls relative to the minute. One job per schedule per 60 s slot is also the finest resolution (`timekeeper.js`). Fine for "within 5 minutes" (F-044).
- An early attempt with only 20 s between creating the schedules and the first tick counted 25 plain schedules twice in tick 0. It was never explained with certainty (a warm-up fire delivered after the minute boundary is the likely cause); the harness now leaves 90 s or more and judges the warm-up fires on their own.

### C5. Delayed jobs

Seven delayed jobs, each with its task row in the same transaction (the timer pattern: wake, check the task's state, do nothing if it moved on). A and B: due in 45 s, with every replica killed at 4 s and replacements started at 18 s (A), then those stopped gracefully and replaced again (B). F: due in 12 s, with no replica alive then. E: its task moves on before it wakes. C, D, G: cancelled with the replicas up, with every replica dead, and after the restart. Assertions are in the status table above, including "never early" (checked against the job's own `start_after`) and "ran exactly once".

### C6. The panel enqueues without workers

Step 0: a panel starts against a database where no core has run (so pg-boss's schema is missing), and the exact `start()` failure is recorded (`Error: pg-boss is not installed`); the panel must not have created the schema. Then a core replica boots once (so the schema and queues exist) and stops. The panel enqueues inside a Prisma transaction with no worker alive anywhere, and the job stays `created`. A replica starts and runs it, recorded under the replica's id. The panel's own row in pg-boss's instance registry says `supervise: false`, `schedule: false`, `migrate: false`, no workers. After `stop()` the panel exits with code 0 within milliseconds, before its 5 s safety timer, so nothing of its own holds the event loop. The panel also created the 200 schedules in C4 without running the schedule pass.

### C7. Strict compile

Three checks. (1) `tsc --noEmit` over the spike, which pulls in pg-boss's declaration files (they import `.ts` paths) and Prisma 7's generated client as source. The tsconfig has all eight flags from AGENTS.md plus `erasableSyntaxOnly`, so the code runs on Node 24 without a transpiler. (2) A scan of the spike's own source on its syntax trees (so a comment or a string cannot trip it or hide a hit) for what tsc accepts and AGENTS.md forbids: `as` other than `as const`, `!`, `any`, enum, interface, class, default export, sync file or process APIs, ts-ignore and ts-nocheck, and a pg-boss import outside `src/jobs.ts`. (3) The repo root's ESLint rule set (typescript-eslint strict-type-checked and stylistic-type-checked, the repo's own rules), run through `eslint.config.mjs` in this directory because the root config ignores `spikes/**`. It uses the root's `node_modules`, so the spike adds no lint dependency; without the root's `pnpm install` this part says it was not run and the verdict rests on (1) and (2). A deliberate violation dropped into `src/` was caught by the lint. Notes for the seam:

- `boss.work<Data, Result, typeof options>()` needs its third type argument. Giving only two makes the options type fall back to `WorkOptions`, and the handler loses its metadata typing. A literal `includeMetadata: true` is what selects the handler type that has `createdOn`, `state` and so on.
- `createQueue` takes `Omit<Queue, "name">` (the policy lives on `Queue`, not on `QueueOptions`).
- Every ID is a branded type (`ids.ts`); the job payloads, the harness messages and the handlers share one set of Zod schemas (`payloads.ts`, `messages.ts`). A task's state is a `z.enum`.

### Other findings for ostra

1. **Prisma 7 + `@prisma/adapter-pg` + `timestamptz` + a Postgres session that is not in UTC stores the wrong instant** (observation O1: off by the session's UTC offset, -5.5 h in the probe, and invisible through Prisma because it reads the same way back). pg-boss, SQL and anything else see the wrong time. ostra's database must run in UTC (`ALTER DATABASE ... SET timezone TO 'UTC'`, or `options=-c TimeZone=UTC`), or its columns stay on Prisma's default `timestamp(3)`. This wants a line in the configuration reference and a check at boot. Found because this laptop's zone is Europe/Berlin; the harness now forces UTC on every scenario database.
2. **Timing settings ostra will need to choose.** `heartbeatSeconds` is at least 10. Recovery of a dead replica's jobs is the heartbeat going stale plus the next monitor pass, so `monitorIntervalSeconds` and `superviseIntervalSeconds` (default 60) decide it. Used here: 10, 5 and 5.
3. **Queue settings are stored per queue** (`retryLimit`, `heartbeatSeconds`, `expireInSeconds`, `policy`), set at `createQueue`. The limit per group is not. `policy` and `partition` cannot be changed afterwards; `heartbeatSeconds` can, in 12.38.2 (`UpdateQueueOptions` re-adds it as `number | null`, types.d.ts; the plan sets `heartbeat_seconds` from it, plans.js `updateQueue`), and a job takes its queue's value when it is inserted. An earlier version of this README said it could not; that was wrong, and it is what the C4 fix uses.
4. **A panel that starts before the core fails to start** (`pg-boss is not installed`, C6 step 0), so ADR 0016's "the panel may boot before the core" needs a retry or a wait in the panel.
5. **A fixed job key needs `policy: "exclusive"`** (C1, F to H); `singletonKey` alone does nothing on a standard queue.
6. **pg-boss's schedule forwarding queue is the weak spot** (C4): pg-boss creates it with no heartbeat, so a replica killed while it holds a batch strands those occurrences for the 15-minute expiry, after which the whole batch is replayed and re-sends what had already gone through. A heartbeat set with `updateQueue` plus a singleton key and 60 s slot on every schedule closed it in 4 of 4 runs; see "C4 and C3 on DBOS, and the root causes".
7. **embedded-postgres on Windows.** The checkout path must stay short (`postgres.exe` fails at 260 characters). `stop()` with `persistent: false` throws EBUSY while Windows holds files, so the harness deletes the data directory itself, with retries. The test cluster runs with `fsync=off` and `max_connections=400`.
8. **The harness's own hygiene** (review findings): every child process gets an allowlisted environment, never the developer's shell; the harness exits non-zero unless every selected scenario is PASS; the lock file and, on a shared server, every database the run created are removed on every exit path.

## Dependencies (exact versions)

| Package | Version | License | Why |
|---|---|---|---|
| `pg-boss` | 12.38.2 | MIT | the queue under test (ADR 0037) |
| `@dbos-inc/dbos-sdk` | 5.6.0 | MIT | the build order's fallback, for D3 and D4 only (the version `research/durable-execution.md` cites). Its MIT core only: no Conductor, no `@dbos-inc/dbos-enterprise`. It brings `superjson` 1.13.3, `serialize-error` 8.1.0, `commander` 12.1.0 and `yaml` 2.9.1 (all MIT, resolved from its ranges). **Spike-only**: ADR 0037 keeps pg-boss, and nothing outside this directory depends on it |
| `@prisma/client` | 7.10.1 | Apache-2.0 | Prisma 7 client (ADR 0007) |
| `@prisma/adapter-pg` | 7.10.1 | Apache-2.0 | Prisma 7's driver adapter, which `fromPrisma` needs |
| `prisma` | 7.10.1 | Apache-2.0 | `prisma generate` and `migrate deploy` |
| `pg` | 8.23.1 | MIT | the harness's own queries (pg-boss and embedded-postgres depend on it too) |
| `embedded-postgres` | 18.6.0-beta.19 | MIT (the Postgres binaries it ships: PostgreSQL License) | a real Postgres on a machine with no Docker. **Spike-only**: `packages/jobs` CI uses a Postgres service container unless the maintainer says otherwise. It is a beta that ships binaries, so the maintainer has not been asked to approve it as a dependency of anything but this spike |
| `zod` | 4.6.7 | MIT | every boundary: env, IPC, HTTP, SQL rows |
| `typescript` | 5.9.3 | Apache-2.0 | the strict typecheck, and C7's syntax-tree scan |
| `@types/node` | 24.19.2 | MIT | Node 24 types |
| `@types/pg` | 8.23.1 | MIT | types for `pg` |

No other dependency was added (DBOS is the one added for the fallback runs): no tsx (Node 24 strips the types), no vitest (the harness is the test). C7's lint step uses the repo root's `eslint` and `typescript-eslint` from its `node_modules`; this spike does not install them.

## What's left

- **Findings into `context/research/`**: not written, as instructed. After the maintainer has read these runs, write `context/research/spike-durable-queue-choice.md` (same shape as `spike-auth-foundation.md`) from the tables above, with every claim cited, and update Q24 and ADR 0037's status. The DoD "Research" line, ADR 0037's gate and Q24 stay open until then. The numbers come from one Windows laptop.
- **C4: decided by the runs, for the maintainer to confirm.** The fallback was run (D3, D4) and the root cause found; the recommendation is in "C4 and C3 on DBOS, and the root causes": keep pg-boss, drive schedules that start work from ostra's own table with a unique row and a fixed job key per occurrence, and keep the forwarding-queue heartbeat and per-schedule singleton as defence in depth. Not built here: the automation table and the scheduler tick; a run of C4 with it, under the same hunt, is the check that it works. Also open: C1 (transactional enqueue from Prisma) on DBOS, a DBOS run on a fresh install without the one-time `DBOS.migrate`, and C4 with the fix at 10 replicas or under a loaded database, where the 10 s dedupe margin is thinnest.
- **Run it elsewhere**: on Linux, on Postgres 16 and 17 (this was 18.6), and against a real shared server (only `pnpm check:external`'s embedded one was used). LISTEN/NOTIFY was off (`useListenNotify` false), so the polling path is what ran. That is also the supported path behind a pooler in transaction mode, but nothing here tested a pooler.
- **Not exercised**: dead-letter queues and retention, `@pg-boss/dashboard`, the request budgets ostra will build on top, the 1,000-task load test (F-117), a rolling upgrade with two pg-boss versions on one schema (ADR 0022), a replica that stalls and wakes after losing its jobs (no SIGSTOP on Windows), a real GitHub under the C2 lookup, and a kill inside a forwarding batch with 3 survivors or at 10 replicas.
- **Timing defaults**: C2's recovery time was measured with 5 s passes only. Measure the defaults, or pick the settings ostra ships with.
- **C3 under other loads**: more keys, a skewed key distribution, more replicas. The overshoot in the table is probabilistic; the handlers never exceeded the limit in any of the ten passes, which is evidence and not a bound.
- **For the maintainer, not decided here**: whether `groupConcurrency` may guard anything stronger than a throttle (the runs say it held for running work in every pass; the source's recount-and-give-back is a timing argument, not a transaction around the claim; DBOS's partition lock is a real one); the recommendation on schedules above; whether to keep `@dbos-inc/dbos-sdk` in this spike's dependencies once the finding is written up; and whether to hold the panel's start until the core has migrated (C6, step 0).
