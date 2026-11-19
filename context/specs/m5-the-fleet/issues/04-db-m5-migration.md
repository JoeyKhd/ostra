# 04: DB: the milestone 5 migration

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none (milestone 4's migration, its ticket 05, lands first)
Features: every F-ID of the spec's section 2 (their tables)
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`, `src/testing/isolation-models.ts`)
Spec: `../spec.md`, section 5.3

## What to build

One new migration, after milestone 4's, additive only: every change in section 5.3's table. New tables carry `organizationId`, and every project record `projectId` with the composite foreign key to the project (ADR 0026).

- `RunnerPool.joinTokenDays` and `updatedByMemberId`; `JoinToken.revokedByMemberId` and `useCount`.
- `Runner`'s new columns, each only where milestones 2 to 4 haven't added it. Check the schema first, and say in `## Comments` which were already there.
- `BoxSize`, with the three defaults inserted for every organization by the migration.
- `ProjectPool.position` (existing rows numbered by creation) and `AgentProfile.runnerLabels`.
- `Task.queuePriority`, `queuedAt`, `requiredLabels` and `cancelledByMemberId`, backfilled for queued tasks: `queuedAt` from `createdAt`, and `queuePriority` from the ticket's priority, 3 when there is none.
- `Box`'s size, image and waiting columns; `Registry`; `Snapshot`'s registry and builder columns.
- The enum values, the new enums, and the indexes for the queue and the counts.
- Milestone 4's isolation model list gains fixtures for `BoxSize` and `Registry`, so its generated test covers them.

## Done when

- [ ] `pnpm db:migrate` applies to an empty database and to one at milestone 4's head with rows in every earlier table, and the backfill is right on a fixture of queued tasks with and without tickets.
- [ ] Tests: each new composite key refuses a row whose project belongs to another organization; `BoxSize` and `Registry` are unique per organization; the queue's query uses its index (`EXPLAIN` in the test); milestone 4's generated isolation test passes with the new models.
- [ ] Nothing is renamed or dropped; Prisma's generated types compile in every package.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the milestone 5 migration`.

## Comments
