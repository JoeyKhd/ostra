# 05: DB: the milestone 2 migration

Status: done
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

- [x] The migration applies to an empty database and to a database holding milestone 1's demo data, and milestone 1's tests still pass on it.
- [x] Tests: the partial index refuses a second active code task for one ticket, and allows one after the first is stopped; each new model's mapper parses a row; another organization's rows stay invisible through the composite keys.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the milestone 2 schema`.

## Comments
- 2026-11-19, core (contracts): done in `✨ add the milestone 2 schema`, migration `20261119210000_milestone_2` (and `CommandKind.release` already in ticket 02's `20261119200000_command_release`). What builders should know:
  - **Partial unique indexes are declared in `schema.prisma`** (`where: raw(...)`, as milestone 1's are), so Prisma never drops them: `task_one_active_code_task_per_ticket` and `connection_one_linear_per_organization` (one Linear connection that isn't `revoked` per organization). The other checks are raw SQL at the end of the migration, marked `ostra:`.
  - **`Connection.appId` stays required.** A pending Linear row holds `pending` until the admin pastes the client ID, and the development seed holds `api-key` (ticket 06 names both). `Connection.state` defaults to `active` and `webhookMode` to `webhooks`, so milestone 1's GitHub rows stay valid; `failedReason` was added beside `state`.
  - **Blobs:** one `Blob` table for every store (`store` `postgres` or `s3`, `key` the store's key), with `BlobUpload` (with `storeUploadId` and `storeParts` for S3's multipart, ticket 11) and `BlobChunk` (`bytea`, 1 MiB at most). A chunk belongs to its upload or to its blob, never both (a check): finishing moves it.
  - **`TicketWrite`** has `boardId` (required, so `create` knows its board), `payload` (JSON, never logged), and `ticketId` required except for `create` (a check). `Task` gains `ticketId` and `boardId`, and a ticket always has its board (a check).
  - **`IdempotencyRecord` and `RateBudget`** are keyed per organization (`@@unique([organizationId, key])`), so ticket 15's stores are built per organization.
  - **More enums than the spec named:** `TicketStatusCategory`, `IdempotencyState`, `SessionLimit` and `BoxReleaseReason` (mapped to the protocol's hyphens in `src/enums.ts`), and `WebhookDeliveryStatus.ignored` for the own echo.
  - **New branded IDs:** `TicketId`, `ExternalTicketId` (the tracker's stable ID), `TicketWriteId`, `OAuthStateId`. New mappers for every new model, plus `mapBoard`; `mapTask`, `mapSession`, `mapBox` and `mapConnection` map their new columns.
  - **A milestone 1 bug fixed on the way:** the mappers' `optional()` typed a nullable ID by the schema's input, so every nullable ID came out as a bare `string`. It's typed by the output now, and they keep their brands.
  - The panel got copy for the two new needs-you reasons (`restore_conflict`, `unstorable_event`) in the Home and task-row words, since their switches are exhaustive.
  - Tests in `src/schema-m2.test.ts`, including an upgrade: milestone 1's migrations, a miniature of its demo's rows, then milestone 2's migrations over them.
