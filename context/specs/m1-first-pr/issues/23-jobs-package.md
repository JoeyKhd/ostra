# 23: The jobs package on pg-boss

Status: resolved
Builder: core
Blocked by: 08
Features: the durable queue, built in from milestone 1 (ADR 0037)
Packages: `packages/jobs`, `eslint.config.js` (one rule)
Spec: `../spec.md`, sections 4 and 5.4

## What to build

- `pg-boss` 12.38.2, exact pin, imported only here. An ESLint `no-restricted-imports` rule refuses `pg-boss` in every other package (ADR 0037).
- `createJobs({ db, role })`: `role` is `enqueue-only` (the panel) or `worker` (core). It implements ticket 08's `JobQueue` port: `enqueueInTx(tx, job, payload, options)` with `{ db: fromPrisma(tx) }`, so a job exists only if its transaction commits.
- Typed workers: `work(job, handler)` takes a job from ticket 08's catalogue and hands the handler a payload parsed by its schema. Heartbeats on, retries with backoff, a dead-letter queue, keys per ADR 0037's rule (sending a job twice returns the existing one), delayed jobs, cancel, and schedules by cron for `catalog.refresh` and `provider.refresh-models`.
- Every handler re-reads the task's state before it acts and does nothing if the task has moved on (ADR 0037, rule 1). The package gives a helper that makes that the default shape.
- Logs: job name, key and IDs only.

## Port from

`spikes/durable-queue-choice/src/jobs.ts`, `job-defs.ts`, `payloads.ts`, `replica.ts`, and its scenarios `c1-transactional-enqueue`, `c5-delayed-jobs`, `c6-panel-no-workers` as tests.

## Done when

- [ ] Tests on the dev test database: a job enqueued in a rolled-back transaction doesn't exist; a duplicate key returns the first job; a delayed job survives a worker restart and can be cancelled; an `enqueue-only` instance runs no handler.
- [ ] The lint rule fails a test file that imports `pg-boss` outside the package.
- [ ] Package checks pass.
- [ ] Committed as `✨ add the jobs package on pg-boss`.

## Comments

- 2026-11-18, core: done in 822283e (`✨ add the jobs package on pg-boss`). `packages/jobs`: `createJobs({ databaseUrl, role })` (`enqueue-only` never migrates, supervises, schedules or works; `worker` installs the schema and one exclusive queue per job name, with heartbeats, exponential retries and the `ostra.dead-letter` queue), `enqueueInTx`/`sendInTx` through `fromPrisma(tx)` (a duplicate key returns the existing job), `work`, `schedule`/`unschedule` by cron, `cancelInTx` by key, `find`. `onCurrentTask(db, { isCurrent, act })` is rule 1's shape: it locks the task row `FOR UPDATE`, scoped by organization, and skips a task that moved on. The ESLint rule already existed; `lint-rule.test.ts` runs the repo's config on a test file of another package. `createJobs` takes `databaseUrl` rather than a Prisma client: pg-boss needs its own pool for the worker, and enqueues go through the caller's transaction. Package checks and the license check green.
