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

Machine: Windows 11, Node 24.14.0, pnpm 11.28.2, Postgres 18.6 (embedded-postgres), pg-boss 12.38.2, Prisma 7.10.1. Other spikes were running on the same machine during the runs, so the timings come from a loaded laptop. One consolidated `pnpm spike` run (18:58 to 19:21 UTC, about 23 minutes) gave **6 of 7 PASS and 1 FAIL (C4), nothing skipped; the exit code was 1**. A review of the first version of this spike found that its C4 never hit the window that matters, and its C2 and C3 were weaker than they looked; C2, C3 and C4 were rebuilt, and C4 now fails:

| # | Pass-bar bullet | Status | What the run showed |
|---|---|---|---|
| C1 | A job enqueued inside a Prisma 7 transaction exists only if the transaction commits. | **PASS** | Rolled back: no job, no task row. Committed: both, and a replica ran it. Held open: invisible to other connections and to polling workers until commit. Panel killed with `kill -9` mid-transaction: nothing. Control without `fromPrisma(tx)`: the job survives the rollback. New: a job under a fixed key sent twice is one job on an exclusive queue (the second send is `deduplicated`), two jobs on a standard queue (control), and a new job once the first has completed. |
| C2 | `kill -9` on one of two replicas mid-job: the job resumes on the other, and a fake GitHub that counts idempotency keys sees no duplicate. | **PASS** | Three kill points, 6 jobs each: after the effect was recorded (all 6 re-ran on the other replica 15.3 s later; 6 POSTs for 6 keys; control with no lookup: 12 POSTs), **in the check-then-POST gap** (the fake had counted all 6 POSTs and held the responses, the victim had recorded 0 `created` rows; the retries found the pull requests by branch; 6 POSTs; control: 12), and **before the effect** (the fake held 6 uncounted requests and dropped them when the client died; the retries created them; 6 POSTs). |
| C3 | A limit of 2 per key holds across three replicas for 1,000 jobs on 20 keys. Any brief overshoot is recorded. | **PASS (overshoot: peak 7 at limit 2, longest 50 ms in the job table; handlers peaked at 2)** | Short pass, 1,000 jobs of 40 to 100 ms: all ran once in 12.1 s; the job table showed a group above 2 in 0.68% of 48,695 snapshots, peak 6, longest episode 50 ms. **Long pass, 200 jobs of 2 to 4 s:** peak 7, longest episode 49 ms (0.35% of 55,944 snapshots). In both passes the handlers' own start and end records never showed more than 2 running in a group. |
| C4 | 200 schedules created at runtime each fire once per tick while replicas restart. | **FAIL** | 5 kills landed while a schedule-forwarding batch was active; 3 stranded it (150 occurrences held `active` by a dead replica). **128 of 800 (schedule, tick) pairs did not fire in their tick**: they fired 15.3 to 17.3 minutes late, when pg-boss expired the stranded batch and replayed it, and **22 occurrences fired a second time** by that replay. The other 672 pairs fired once, and the warm-up fires stayed within each schedule's occurrences. The first version of this scenario passed in each of three runs (2,400 pairs), because its kills never landed in a batch. |
| C5 | Delayed jobs survive a restart and can be cancelled. | **PASS** | Jobs due in 45 s ran once, 0.3 s after falling due, after `kill -9` of every replica and a graceful restart. A job that fell due with no replica alive ran 0.4 s after the restart began. Three cancellations (replicas up, all dead, after the restart): none ran. |
| C6 | The panel process enqueues without running workers. | **PASS** | With no replica alive the panel's job waited 6 s untouched. Registry row: no supervise, no schedule, no migrate, 0 workers. The panel exited by itself 27 ms after `stop()`. New: a panel started against a database with no pgboss schema fails to start (`Error: pg-boss is not installed`) and creates nothing. |
| C7 | It compiles under ostra's strict flags. | **PASS** | `tsc 5.9.3 --noEmit` exits 0 with all 8 flags set, over pg-boss's types and the generated Prisma 7 client. A syntax-tree scan of the 25 source files finds no `as` but `as const`, no `!`, no `any`, no enum, interface, class, default export or sync API. The repo root's ESLint rules (strict-type-checked, stylistic-type-checked, the repo's own) report 0 problems. |

**C4 failed, so the build order's fallback applies: run C4 on DBOS and compare. That was not done** (it needs DBOS Transact as a new dependency and a second implementation of the scenario; the maintainer should decide). What the spike did try is whether pg-boss's own settings close the gap; see "C4 experiment" below. The failure is in pg-boss's schedule forwarding, not in its job queues: C1, C2, C3 and C5, which cover everything else ADR 0037 puts on pg-boss, passed.

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
pnpm spike             # every criterion: about 9 minutes with no stranded batch, about 25 when C4 strands one (it then waits out pg-boss's 15-minute expiry)
pnpm check:external    # the SPIKE_DATABASE_URL path against a real server, about 40 s
```

A subset or a shorter C4, in the two shells this machine has:

| | Git Bash / POSIX | PowerShell |
|---|---|---|
| C1 and C3 only | `SPIKE_ONLY=C1,C3 pnpm spike` | `$env:SPIKE_ONLY="C1,C3"; pnpm spike` |
| a shorter C4 | `SPIKE_SCHEDULE_TICKS=2 SPIKE_ONLY=C4 pnpm spike` | `$env:SPIKE_SCHEDULE_TICKS="2"; $env:SPIKE_ONLY="C4"; pnpm spike` |
| a shared Postgres server | `SPIKE_DATABASE_URL=postgresql://... pnpm spike` | `$env:SPIKE_DATABASE_URL="postgresql://..."; pnpm spike` |

(In PowerShell the variables stay set for the session: `Remove-Item Env:SPIKE_ONLY` clears one.)

Exit code: 0 only when every selected scenario is PASS. A SKIPPED scenario (no Postgres could be started) or an unknown id in `SPIKE_ONLY` is not green.

Other knobs (all optional, each with a default):

| Variable | Default | Effect |
|---|---|---|
| `SPIKE_ONLY` | all | comma-separated ids: C1 to C7, and O1 for the observation |
| `SPIKE_DATABASE_URL` | embedded-postgres | a Postgres server to use instead; needs CREATE and DROP DATABASE. A generic `DATABASE_URL` in your shell is ignored on purpose |
| `SPIKE_RUN_ID` | random | 8 hex digits suffixed to every database the run creates |
| `SPIKE_SCHEDULE_COUNT` / `SPIKE_SCHEDULE_TICKS` | 200 / 4 | C4: schedules and whole minutes |
| `SPIKE_SCHEDULE_HUNT_KILLS` | 3 | C4: strikes that must strand a forwarding batch (the hunt tries at most 3 times that many) |
| `SPIKE_STRAND_WAIT_MINUTES` | 17 | C4: how long to wait for a stranded forwarding batch (only if one happened) |
| `SPIKE_SEND_IT_EXPIRE_SECONDS` | unset (pg-boss's 900) | C4 experiment: the expiry set on pg-boss's forwarding queue by every replica |
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

**C4 experiment: a 30 s expiry on the forwarding queue.** `SPIKE_SEND_IT_EXPIRE_SECONDS=30` makes each replica call `updateQueue("__pgboss__send-it", { expireInSeconds: 30 })` once it has started (the queue's `heartbeatSeconds` cannot be changed after creation). One run (`SPIKE_ONLY=C4`): 3 strikes, all three stranded a batch (150 occurrences: 100 from the warm-up, 50 in tick 0). pg-boss freed them within about a minute, replayed them, and **800 of 800 (schedule, tick) pairs fired exactly once, none late**. But **5 plain schedules fired three times in the warm-up window**, which had two occurrences (the replay repeated sends that had already gone through), and none of the 100 guarded schedules (singleton key and 60 s slot) did. The verdict was still FAIL, on those 5. One run is a lead and not a result: a replay that crosses a minute boundary lands in another slot, and the guard would not catch it.

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
3. **Queue settings are stored per queue** (`retryLimit`, `heartbeatSeconds`, `expireInSeconds`, `policy`), set at `createQueue`. The limit per group is not. `heartbeatSeconds` and `policy` cannot be changed afterwards (`UpdateQueueOptions` omits them).
4. **A panel that starts before the core fails to start** (`pg-boss is not installed`, C6 step 0), so ADR 0016's "the panel may boot before the core" needs a retry or a wait in the panel.
5. **A fixed job key needs `policy: "exclusive"`** (C1, F to H); `singletonKey` alone does nothing on a standard queue.
6. **pg-boss's schedule forwarding queue is the weak spot** (C4): it has no heartbeat, so a replica killed while it holds a batch strands those occurrences for the 15-minute expiry, after which the batch is replayed.
7. **embedded-postgres on Windows.** The checkout path must stay short (`postgres.exe` fails at 260 characters). `stop()` with `persistent: false` throws EBUSY while Windows holds files, so the harness deletes the data directory itself, with retries. The test cluster runs with `fsync=off` and `max_connections=400`.
8. **The harness's own hygiene** (review findings): every child process gets an allowlisted environment, never the developer's shell; the harness exits non-zero unless every selected scenario is PASS; the lock file and, on a shared server, every database the run created are removed on every exit path.

## Dependencies (exact versions)

| Package | Version | License | Why |
|---|---|---|---|
| `pg-boss` | 12.38.2 | MIT | the queue under test (ADR 0037) |
| `@prisma/client` | 7.10.1 | Apache-2.0 | Prisma 7 client (ADR 0007) |
| `@prisma/adapter-pg` | 7.10.1 | Apache-2.0 | Prisma 7's driver adapter, which `fromPrisma` needs |
| `prisma` | 7.10.1 | Apache-2.0 | `prisma generate` and `migrate deploy` |
| `pg` | 8.23.1 | MIT | the harness's own queries (pg-boss and embedded-postgres depend on it too) |
| `embedded-postgres` | 18.6.0-beta.19 | MIT (the Postgres binaries it ships: PostgreSQL License) | a real Postgres on a machine with no Docker. **Spike-only**: `packages/jobs` CI uses a Postgres service container unless the maintainer says otherwise. It is a beta that ships binaries, so the maintainer has not been asked to approve it as a dependency of anything but this spike |
| `zod` | 4.6.7 | MIT | every boundary: env, IPC, HTTP, SQL rows |
| `typescript` | 5.9.3 | Apache-2.0 | the strict typecheck, and C7's syntax-tree scan |
| `@types/node` | 24.19.2 | MIT | Node 24 types |
| `@types/pg` | 8.23.1 | MIT | types for `pg` |

No other dependency was added: no tsx (Node 24 strips the types), no vitest (the harness is the test). C7's lint step uses the repo root's `eslint` and `typescript-eslint` from its `node_modules`; this spike does not install them.

## What's left

- **Findings into `context/research/`**: not written, as instructed. After the maintainer has read these runs, write `context/research/spike-durable-queue-choice.md` (same shape as `spike-auth-foundation.md`) from the tables above, with every claim cited, and update Q24 and ADR 0037's status. The DoD "Research" line, ADR 0037's gate and Q24 stay open until then. The numbers come from one Windows laptop.
- **C4 failed: decide what happens next.** The build order says to run the failed scenario on DBOS and compare; that was not done. Options the runs suggest, none of them applied to ostra yet: (1) the experiment above, a 30 s expiry on pg-boss's forwarding queue plus a singleton key and a 60 s slot on every schedule, which lost nothing and duplicated nothing for the guarded schedules but is one run, still leaves plain schedules open to a duplicate, and dedupes only while the replay lands in the same 60 s slot; (2) keeping schedules out of pg-boss's cron: ostra's own table of automations and a keyed, idempotent per-occurrence job (`task:<AutomationId>:<occurrence>`, on an exclusive queue, as C1 shows) so a replay is a no-op; (3) DBOS for schedules only. A reconciliation pass rebuilds work from ostra's tables (ADR 0037, rule 1), so a late or repeated one costs little; automations (F-106), which start agent work, are the schedules for which a duplicate or a fire 15 minutes late costs something.
- **Run it elsewhere**: on Linux, on Postgres 16 and 17 (this was 18.6), and against a real shared server (only `pnpm check:external`'s embedded one was used). LISTEN/NOTIFY was off (`useListenNotify` false), so the polling path is what ran. That is also the supported path behind a pooler in transaction mode, but nothing here tested a pooler.
- **Not exercised**: dead-letter queues and retention, `@pg-boss/dashboard`, the request budgets ostra will build on top, the 1,000-task load test (F-117), a rolling upgrade with two pg-boss versions on one schema (ADR 0022), a replica that stalls and wakes after losing its jobs (no SIGSTOP on Windows), a real GitHub under the C2 lookup, and a kill inside a forwarding batch with 3 survivors or at 10 replicas.
- **Timing defaults**: C2's recovery time was measured with 5 s passes only. Measure the defaults, or pick the settings ostra ships with.
- **C3 under other loads**: more keys, a skewed key distribution, more replicas. The overshoot in the table is probabilistic; the handlers never exceeded the limit in any of the ten passes, which is evidence and not a bound.
- **For the maintainer, not decided here**: whether `groupConcurrency` may guard anything stronger than a throttle (the runs say it held for running work in every pass; the source's recount-and-give-back is a timing argument, not a transaction around the claim); whether schedules should carry a singleton key and slot by default (the experiment says yes, for the replay case); and whether to hold the panel's start until the core has migrated (C6, step 0).
