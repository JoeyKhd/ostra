# 04: DB: the milestone 5 migration

Status: done
Builder: core (contracts, first)
Blocked by: none (milestone 4's migration, its ticket 05, lands first)
Features: every F-ID of the spec's section 2 (their tables)
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`, `src/testing/isolation-models.ts`)
Spec: `../spec.md`, section 5.3

## What to build

One new migration, after milestone 4's, additive only: every change in section 5.3's table. New tables carry `organizationId`, and every project record `projectId` with the composite foreign key to the project (ADR 0026).

- `RunnerPool.joinTokenDays` and `updatedByMemberId`; `JoinToken.revokedByMemberId` and `useCount`.
- `Runner`'s new columns, each only where milestones 2 to 4 haven't added it. Check the schema first, and say in `## Comments` which were already there.
- `BoxSize`, with the three defaults inserted for every organization by the migration, and by the first admin's seed (`seedFirstAdmin`) for an install that first starts after it. *Changed 2026-11-19: `createOrganization` was to seed them for new organizations, and it moved after v1 with several organizations (F-134).*
- `ProjectPool.position` (existing rows numbered by creation) and `AgentProfile.runnerLabels`.
- `Task.queuePriority`, `queuedAt`, `requiredLabels` and `cancelledByMemberId`, backfilled for queued tasks: `queuedAt` from `createdAt`, and `queuePriority` from the ticket's priority, 3 when there is none.
- `Box`'s size, image and waiting columns; `Registry`; `Snapshot`'s registry and builder columns.
- The enum values, the new enums, and the indexes for the queue and the counts.
- Milestone 4's isolation model list gains fixtures for `BoxSize` and `Registry`, so its generated test covers them.

## Done when

- [x] `pnpm db:migrate` applies to an empty database and to one at milestone 4's head with rows in every earlier table, and the backfill is right on a fixture of queued tasks with and without tickets.
- [x] Tests: each new composite key refuses a row whose project belongs to another organization; `BoxSize` and `Registry` are unique per organization; the queue's query uses its index (`EXPLAIN` in the test); milestone 4's generated isolation test passes with the new models.
- [x] Nothing is renamed or dropped; Prisma's generated types compile in every package.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the milestone 5 migration`.

## Comments

- 2026-11-19: built. `packages/db/prisma/migrations/20261124000000_milestone_5/migration.sql`, after milestone 4's and after protocol minor 4's `20261123000000_command_resume` (which holds `CommandKind`'s `resume`, ticket 01). Its SQL is Prisma's own diff of the schema, plus the checks (a size's name and limits, a project's and a box's size name, a box's waiting reason with its time, a priority from 1 to 4, no negative count, lifetime, position or offer) and the backfills (the three sizes for every organization, each project's pools numbered by their pools' creation, since `project_pool` has no time of its own, and for queued tasks `queuedAt` from `createdAt` and `queuePriority` from the ticket, 3 without one). Already there, so not added: `Runner.processContainment` (milestone 2: the containment), `Snapshot.runnerId` (milestone 3) and `Project.defaultBoxSize` (milestone 1, now checked). `BoxSize` and `Registry` are organization records with no project, so their composite keys are `Runner.joinTokenId` → `JoinToken` and `Snapshot.registryId` → `Registry`, both with the organization. `seedFirstAdmin` makes the three sizes (`ensureBoxSizes`, `packages/domain/src/use-cases/pools.ts`). The new enum values reach their callers in the same commit: the needs-you views and the task list word `runner_awaiting_approval` and `cancelled` (`apps/web/messages/en.json`), and a `runner_awaiting_approval` item sends no notification of its own, since the join's runner notices do (ticket 12). For ticket 12: `NeedsYouItem` needs a task (`taskId` is required), so an item for a runner waiting for approval needs a column of its own or the notices alone; this migration leaves that to it. Proof: `packages/db/src/schema-m5.test.ts` (the upgrade from milestone 4's head with rows, the keys, the uniques, the checks and `EXPLAIN` on the queue's and the counts' indexes, with break-its: dropping the queue's index, the priority backfill or the token key's organization each failed its test) and `packages/api/src/auth/first-admin-seed.test.ts` (the seed's sizes; `context/proof/F-095.md`). Milestone 4's isolation model list (`packages/db/src/testing/isolation-models.ts`, its ticket 09, which landed while this was built) gains builders for `BoxSize` and `Registry`, and the generated suite's readers table names them with no reader yet (tickets 27 and 28 add theirs); `packages/db/src/isolation-models.test.ts` and `packages/api/src/isolation/every-record.test.ts` pass with them. Commit: `05ecc17b` (`✨ add the milestone 5 migration`).
