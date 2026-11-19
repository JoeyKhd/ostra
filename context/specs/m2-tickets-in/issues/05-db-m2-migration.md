# 05: DB: the milestone 2 migration

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none
Features: every F-ID of the spec's section 2 (their rows)
Packages: `packages/db` (`prisma/schema.prisma`, a new migration, `src/enums.ts`, row mappers), `packages/protocol/src/ids.ts` (new branded IDs, additive)
Spec: `../spec.md`, section 5.3

## What to build

One migration, additive only: every table, column, index and enum value of spec section 5.3. Nothing is renamed or dropped, because other teams' installs upgrade on their own schedule.

- New models `Ticket`, `TicketWrite`, `IdempotencyRecord`, `RateBudget`, `Blob`, `BlobChunk`, `BlobUpload` and `OAuthState`, each with `organizationId`, and `projectId` with the composite foreign key where it's a project record.
- New columns on `Connection`, `Board`, `Task`, `TaskRepo`, `Session`, `Box`, `Project`, `InstanceSetting` and `WebhookDelivery`, each nullable or with a default, so existing rows stay valid.
- The partial unique index on `task (projectId, ticketId)` for active code tasks, in raw SQL in the migration.
- Enum values added with `ALTER TYPE ... ADD VALUE`, mapped both ways in `src/enums.ts`: `CommandKind.release`, `NeedsYouReason.restore_conflict` and `unstorable_event`, and the new enums.
- Row mappers that parse IDs into their branded types for every new model, with branded `TicketId`, `BoardId`, `ConnectionId` and `BlobId` in `packages/protocol/src/ids.ts` where they don't exist yet.
- `BlobChunk.bytes` is `bytea`, at most 1 MiB a row. Blobs never share a table with the event log (ADR 0043).

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **More columns and one more table,** from the targets (spec section 5.3, the rows marked *Added 2026-11-19*). All are additive and nullable:
  - `Connection`: `credentialKind` (new enum `ConnectionCredential`: `app_oauth`, `app_client_credentials`, `api_key`), `externalWorkspaceKey`, `externalWorkspaceName`, `appUserName`, `activatedAt`, `createdByMemberId`
  - `WebhookDelivery.ticketKey`
  - `Board.key`
  - `Repo`: `private`, `branchRules` (JSON), `branchRulesCheckedAt`
  - `InstanceSetting.retentionSetAt`
  - the new `OrganizationSetting`: `organizationId` (the key and the foreign key), `linearSkippedAt`, `linearSkippedByMemberId`, `updatedAt`
- **`credentialKind`** is set on every Linear connection. `api_key` is the development seed only (spec section 3, "Until the maintainer authorizes the Linear app"), and no API procedure writes it.

## Done when

- [ ] The migration applies to an empty database and to a database holding milestone 1's demo data, and milestone 1's tests still pass on it.
- [ ] Tests: the partial index refuses a second active code task for one ticket, and allows one after the first is stopped; each new model's mapper parses a row; another organization's rows stay invisible through the composite keys.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the milestone 2 schema`.

## Comments
