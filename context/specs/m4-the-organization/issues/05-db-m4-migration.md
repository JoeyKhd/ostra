# 05: DB: the milestone 4 migration

Status: done
Builder: core (contracts, first)
Blocked by: none (milestone 3's migration, its ticket 06, lands first)
Features: every F-ID of the spec's section 2 (their tables)
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`)
Spec: `../spec.md`, section 5.3

## What to build

One new migration, after milestone 3's, additive only: every change in section 5.3's table. New tables carry `organizationId`, and every project record `projectId` with the composite foreign key to the project (ADR 0026). A nullable `projectId` (an organization note, the organization's budget) keeps the composite key, which Postgres skips when the column is null.

- `Member`'s state and removal columns, `Invitation`'s new columns, `ResetLinkGrant`. *Changed 2026-11-19: `User.lastOrganizationId` and `Organization.createdByUserId` are out of this migration. They serve the switcher and the instance's Organizations page, which moved after v1 with several organizations (F-134).*
- `AuditEntry.actorName` and its three indexes.
- `SearchEntry`, with its generated `tsvector` column (`to_tsvector('simple', text)`) and GIN index in raw SQL, declared as `Unsupported("tsvector")`.
- `Model`'s price columns where milestone 2 hasn't added them, `SpendDaily`, `Budget` (with the partial unique index for the organization's own), `BudgetNotice`, `HeldTurn`.
- `TaskMetric`, `InsightDaily`, `InsightRun`.
- `MemoryNote` and `MemoryProposal` with their generated vectors over title and body, `MemoryNoteVersion`, `MemoryUse`, `AgentProfile.closingTurn`.
- `Repo.position` (existing rows numbered by creation), `ReviewCheck`.
- The new enums and enum values. `src/enums.ts` and the mappers export them, and the branded `NoteId`, `ProposalId`, `BudgetId`, `InvitationId` and `SearchEntryId` exist in `packages/protocol/src/ids.ts` (with ticket 01).
- Not `InstanceSetting.openSignupAccounts` or `openSignupOrganizations`: deprecated and unused since 2026-11-19, they stay, and a later release's migration drops them (spec section 5.3).

## Done when

- [x] `pnpm db:migrate` applies to an empty database and to one at milestone 3's head with rows in every earlier table.
- [x] Tests: each new composite key refuses a row whose project belongs to another organization; each unique index refuses its duplicate, and the organization's budget is unique where `projectId` is null; a `SearchEntry` and a `MemoryNote` are found by `@@` on their vectors.
- [x] Nothing is renamed or dropped; Prisma's generated types compile in every package.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the milestone 4 migration`.

## Comments

- 2026-11-19: migration `20261121000000_milestone_4`, with the generated `tsvector` columns declared to Prisma as `Unsupported("tsvector")` with their `dbgenerated` expression and a GIN `@@index`, so `prisma migrate diff` shows no drift of its own; checks Prisma can't declare at its end (`ostra:`), and the `repo.position` backfill. Enums and mappers in `src/enums.ts` and `src/mappers.ts` (`turnOriginToDb`/`FromDb` for the held turn's hyphenated origins). Tests in `packages/db/src/schema-m4.test.ts`: every composite key across organizations, every unique index, the organization budget and day of Insights where `projectId` is null, the checks, `@@` on the search and note vectors with a near miss, the additive-only guard on the SQL, and an upgrade from milestone 3's head with rows in every altered table. Break-it: dropped `budget_one_per_organization` and the month check from the migration, and the two tests failed. The notification kinds' new values widened `Notification.kind`, so the needs-you delivery narrows with the domain's new `momentKindOf`/`isMomentKind`. Whole-repo typecheck, lint and test green. Commit: `✨ add the milestone 4 migration`.
