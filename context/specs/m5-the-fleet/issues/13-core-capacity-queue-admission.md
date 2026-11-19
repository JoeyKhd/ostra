# 13: Core: capacity, the pool queue and admission

Status: done
Builder: core
Blocked by: 05
Features: F-067, F-095, F-014
Packages: `apps/core` (`src/dispatch/dispatcher.ts`, `src/dispatch/admission.ts` (new)), `packages/domain` (`queueTask`, `admitQueued`, `cancelQueuedTask`, `recordRunnerReport`)
Spec: `../spec.md`, section 4 ("What a runner reports", "Admission"); ADR 0059, ADR 0037

## What to build

- **Reports:** `recordRunnerReport` keeps a runner's slots, resources, capabilities, labels (with the built-in ones core adds), install, minor and containment from every `hello` and `status`. A runner can't set a reserved label; one that tries has it dropped and a log line with its ID.
- **Queueing:** `queueTask` sets `queuedAt`, `queuePriority` (from the ticket, 3 for prompts and tickets without one) and `requiredLabels` (from the profile), on a new task, a reopen and a requeue.
- **Admission:** `queue.admit` keyed by pool, enqueued by every change of section 4's list, plus a sweep every `OSTRA_QUEUE_SWEEP_SECONDS`. Under the pool's row lock, it walks the pool's queue in `queueOrder`, and for each task, in its own transaction, counts the pool's and the project's boxes from `Box` rows, calls `chooseRunner` (ticket 14) and either grants the lease and the offer (milestone 1's) or records the task's wait reason with its place. A project at its share is passed over. A personal runner's tasks are admitted against that runner's slots (2 by default), outside any pool.
- **Requeues:** an offer declined or timed out, a box failed as `no-node` or `no-room` (ticket 08), and a revoked runner's tasks go back to the queue with their original `queuedAt`, so they keep their place.
- **Cancel:** `cancelQueuedTask` stops a queued task as `cancelled` with `cancelledByMemberId`, writes `task.cancelled` and the server-only event, in one transaction. An admin may cancel any; a member their own.

## Done when

- [x] Tests named for `F-067`: capacity from slots, CPU and memory; a personal runner's two; the queue's order; a project at its share passed over while another's task starts; fifty admissions raced from three core replicas never exceed a share or a cap (counted afterwards from rows); a requeue keeps its place; cancel by an admin, by the task's member, and refused for another member.
- [x] Break-it: counting the share outside the admitting transaction lets the race exceed it and fails the test; recorded in `context/proof/F-067.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the pool queue and admission`.

## Comments

- 2026-11-20: built in `packages/domain/src/use-cases/admission.ts` (`queueTask`, `admitQueued`, `poolQueueInTx`, `requeueTaskInTx`, `cancelQueuedTask`), `fleet-rows.ts` (the locks and the rows the choice reads), `runner-report.ts` (`recordRunnerReport`), and core's `queue.admit` handler and sweep in `apps/core/src/dispatch/dispatcher.ts`. Tests: `apps/core/src/dispatch/admission.test.ts`; proof rows in `context/proof/F-067.md` and `F-095.md`. Decisions made while building:
  - Each task's admission is `dispatchTask` in its own transaction: the task's row (`SKIP LOCKED`), then the project's pools' rows in ID order (`FOR NO KEY UPDATE`), then the count from `Box` rows and `chooseRunner`. A `task.dispatch` job for a pool task now only queues it (`queueTask`) and sends its pools' `queue.admit`, so the queue's order holds; a personal runner's task is granted by its `task.dispatch` under the runner's row lock.
  - The existing 5 s requeue sweep became the queue's sweep, every `OSTRA_QUEUE_SWEEP_SECONDS`: `queue.admit` per pool with queued work, and a fresh `task.dispatch` for queued personal tasks.
  - `queue.admit` is also sent when a runner comes online, when its report shows more room, and when a lease is released (`releaseLeaseInTx` with the jobs port). Approve, resume and share changes (tickets 12, 15, 27) can call `enqueueRunnerAdmissionInTx` or `enqueueProjectAdmissionInTx`; the sweep catches anything they don't.
  - A personal runner's slots: what it reported; one at minor 4 that hasn't reported takes `OSTRA_PERSONAL_RUNNER_CAPACITY`; one below minor 4 runs its own `--capacity`, which it enforces. Ticket 19's runner reports 2 by default.
  - A revoked pool runner's unaccepted offers go back to the queue with their place; a personal runner's task still stops as `runner_lost` (Q131), since it has nowhere else to go. `RevokeRunnerDeps` gains an optional `jobs`.
  - A box that was never placed (`no-node`, `no-room`) after the runner accepted needs `preparing` → `queued`: a new task input, `box_unplaced`. `requeueTaskInTx` does it; ticket 20's ingest calls it when the runner reports the failure.
  - Milestone 3's test "a busy docker runner makes the task wait for a slot" now expects `queued { poolId, place }`, not `no-runner-online`: a runner fits and none has room, which is ADR 0059's `queued`.
  - A reopen clears `queuedAt`, so it takes a new place when it's queued.
  - The second row of F-067 stays `partial` until an admin can see the queue (ticket 26, ticket 33). F-067 is `building`.
