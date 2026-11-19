# 21: Core: nothing lost across a server restart

Status: ready-for-agent
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

- [ ] Every kill point passes ten times in a row.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✅ add the server restart harness`, with each fix in its own `🐛` commit.

## Comments
