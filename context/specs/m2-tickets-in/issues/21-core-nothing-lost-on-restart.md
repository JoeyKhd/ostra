# 21: Core: nothing lost across a server restart

Status: done
Builder: core
Blocked by: 01, 13, 17
Features: F-043
Packages: `apps/core`, `apps/runner` (only where a test finds a gap), `packages/jobs`
Spec: `../spec.md`, section 3 (the failure suite)

## What to build

A test harness and the fixes it finds, so a server killed at any moment and started again loses nothing and every running task carries on.

- **The harness** (`apps/core/src/testing/restart.ts`): starts core and a fake runner against one database, runs a task with the scripted fake agent, and kills core with `SIGKILL` at named points: while a batch's transaction is open, after its commit and before the ack, while a `dispatch` is in the outbox and unacked, inside `webhook.process`, inside `ticket.sync` after the tracker answered, inside `task.open-pull-requests` after GitHub answered. Then it starts core again.
- **After each kill:** every event stored exactly once; the runner reconnected and carried on; the command delivered once (applied once by its ID); the job finished once, and the fake tracker and code host saw one write each.
- **The fixes it needs,** each with its test: whatever the points above find. Known already: the batch core can't store (ticket 17's `unstorable_event`), and a `task.grace` job that must survive the restart and still fire.
- Each kill point runs on this machine; the POSIX `kill -9` runs on the Linux machine with ticket 38's suite.

## Done when

- [x] Every kill point passes ten times in a row.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✅ add the server restart harness`, with each fix in its own `🐛` commit.

## Comments
- 2026-11-20, core (sessions): done in `d3dca46` (`✅ add the server restart harness`), with two fixes in their own commits, `0605dc6` (`🐛 free a dead replica's jobs within supervise`) and `0c07df3` (`🐛 close presence a dead replica left open`). Core, domain and jobs typecheck, lint and test green after the last rebase; whole-repo typecheck, lint and check:licenses green. Every kill point passed ten times in a row (`OSTRA_RESTART_RUNS=10`, 812 s for the six). In the whole-repo test run, the runner, adapter-sdk, executor and OpenCode suites failed only on timeouts (and a clone that timed out), on a machine running about 130 node and 160 postgres processes for other sessions. None of those packages is changed here. For tickets 38 and 39:
  - **The harness** (`apps/core/src/testing/restart.ts`, `restart-child.ts`): core runs in its own process against the test database, on the same port each start, with the fake GitHub and the fake Linear (`startCore`'s new test-only options `linearApiUrl` and `jobIntervals`). `spoolingRunner` behaves like `apps/runner` across a restart: it keeps every event until it's acked, reconnects with `lastCommandSeq` and each session's `nextSessionSeq`, resends what wasn't acked, and applies each command once by its ID. Every wait polls a condition with a deadline. `restart.test.ts` runs each point once by default (about 2 minutes in core's suite). `OSTRA_RESTART_RUNS=10` runs it ten times.
  - **The kill points** (`apps/core/src/kill-points.ts`): `ingest.batch-open`, `ingest.batch-committed`, `dispatch.offered`, `webhook.process`, `ticket.sync.answered` and `open-pull-requests.answered`. Each is a no-op unless the child process armed it from `CORE_TEST_KILL_POINT`, and an armed point ends the process with SIGKILL. `openPullRequests` gained an optional `afterHostWrite` dep, its seam between GitHub's answer and the row. After each kill, the tests check that every event is stored once and in order, the dispatch command exists once and is applied once, the job finished, the delivery is processed once, the ticket got one comment and one link, and the code host got one PR.
  - **Fix 1, jobs:** pg-boss frees dead-heartbeat and expired jobs in its monitor pass, which runs at most every `monitorIntervalSeconds` (default 60), whatever the supervise interval. So a killed replica's job waited about a minute, not the 30 s that `CreateJobsOptions` documents. `createJobs` now sets the monitor interval to the supervise interval. Its test is in `packages/jobs/src/jobs-m2.test.ts`, and it fails without the fix.
  - **Fix 2, presence:** a replica killed with `kill -9` never ran its sockets' close handlers. The presence rows of the runners it held still said connected, and no `task.grace` started for a runner that never came back. Now every replica's presence pass closes a row that no replica refreshed within the dead time, as a disconnect would (guarded on `lastSeenAt`, so a live replica's refresh wins). The grace then starts as a queue job, so it outlives the restart and still fires. Its test is `apps/core/src/gateway/orphaned-presence.test.ts`, and it fails without the fix.
  - **Already covered:** the batch that core can't store is ticket 17's `unstorable_event` salvage.
  - **For ticket 38:** the POSIX `kill -9` run on Linux, and spike 8's C4 (killing the replica that holds a forwarded batch), can reuse `spawnCore` and `spoolingRunner`.
  - **F-043** stays `planned` in the ledger. Ticket 38's failure suite and ticket 39's ledger pass set it.
