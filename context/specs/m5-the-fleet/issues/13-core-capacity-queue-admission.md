# 13: Core: capacity, the pool queue and admission

Status: ready-for-agent
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

- [ ] Tests named for `F-067`: capacity from slots, CPU and memory; a personal runner's two; the queue's order; a project at its share passed over while another's task starts; fifty admissions raced from three core replicas never exceed a share or a cap (counted afterwards from rows); a requeue keeps its place; cancel by an admin, by the task's member, and refused for another member.
- [ ] Break-it: counting the share outside the admitting transaction lets the race exceed it and fails the test; recorded in `context/proof/F-067.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the pool queue and admission`.

## Comments
