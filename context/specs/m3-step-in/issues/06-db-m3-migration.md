# 06: DB: the milestone 3 migration

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none (milestone 2's migration, its ticket 05, lands first)
Features: every F-ID of the spec's section 2 (their tables)
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`)
Spec: `../spec.md`, section 5.3

## What to build

One new migration, after milestone 2's, additive only: every change in section 5.3's table. New tables carry `organizationId`, and every project record `projectId` with the composite foreign key to the project (ADR 0026). Partial and unique indexes as the table says.

- `AgentProfile`'s new columns, `AgentProfileMember`, `AgentProfileSkill`.
- `Task.agentProfileId` and `planState`; `TaskApprovalRule`; `Approval`'s and `NeedsYouItem`'s new columns.
- `DiffComment`, `DiffCache`, `TaskPullRequest`, `TaskRepo`'s new columns, with a backfill that writes one `TaskPullRequest` per task repo that already has a PR (in the migration's SQL, idempotent).
- `CheckRun`, `Check`'s new columns, `Snapshot`'s new columns, `Turn`'s usage columns.
- `Notification`, `NotificationDelivery`, `NotificationPreference`, `EmailSettings` (one row, created empty by the migration), `CliSession`, `DeviceCode.purpose`, `User`'s GitHub columns with the partial unique index on `githubUserId`, `InstanceSetting.emailDelaySeconds`.
- The new enums and enum values. `src/enums.ts` and the mappers export them, so the domain never spells a database string by hand.
- Secrets (the Resend key, the SMTP password, MCP header values) are secret references, never values: the columns end in `SecretRef`, as milestone 1's do.

## Done when

- [ ] `pnpm db:migrate` applies to an empty database and to one at milestone 2's head with rows in every milestone 2 table; the backfill makes one `TaskPullRequest` per existing PR, and running it twice makes no second one.
- [ ] Tests: each new composite key refuses a row whose project belongs to another organization; each unique index refuses its duplicate; `githubUserId` is unique where set and repeatable where null.
- [ ] Nothing is renamed or dropped; Prisma's generated types compile in every package.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the milestone 3 migration`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **`Snapshot.buildDurationMs`** (nullable integer), written from `snapshot.built { durationMs }`, for the environment's snapshot row (`environment-services.md`, "Data").
- **`NotificationPreference.updatedAt`,** for the notification page's "Last change" (`notification-settings.md`, "Data").
- **No column for the rest of the targets' data.** `AgentProfile.mcpServers` entries carry `readOnly` and `approvalRules` entries carry `preset` inside their JSON, parsed by ticket 01's schemas. `TaskApprovalRule.id` is the protocol's `TaskRule.ruleId`. A service's health stays an event. Spec section 5.3 says the same.

## Comments
