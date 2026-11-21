# 04: DB: the milestone 9 migration

Status: done
Builder: core
Blocked by: none
Features: F-148, F-149
Packages: `packages/db`, `packages/api/src/isolation/` (the fixtures)
Spec: `../spec.md`, section 5.3; ADR 0070

## What to build

One migration after milestone 8's, additive only, as section 5.3's table says:
- the new models `MessageFile` and `TaskTicketRead`, each with `organizationId`, `projectId` and the composite keys to the project, the task and the blob;
- `Model.catalogInputModalities` and `Model.adminImageInput`;
- `ticket_update` in the message intents' mapping (`packages/db/src/enums.ts`), both ways;
- the enums `MessageFileOrigin`, `MessageFileState`, `MessageFileKind`, `FileTextState` and `TicketReadReason`;
- the indexes the sweep, the thread and the spec read by.

`MessageFile.name` and the ticket's text carry `///` comments saying they're never logged. `ticketSourceKey` is the SHA-256 of the tracker's URL: the URL itself isn't stored. A blob's deletion cascades to its `MessageFile` rows' blob columns (`SetNull`), and a task's deletion to its files, as F-079's retention expects.

Milestone 4's generated isolation test gets a fixture for `MessageFile` and `TaskTicketRead`, and fails until each has one.

## Done when

- [x] The migration applies on an empty database and on one at milestone 8's last migration, and `prisma migrate diff` shows nothing else.
- [x] Tests named for `F-148/c3`: the isolation test's every-record case covers both models.
- [x] Checks for the whole repo pass (spec section 10: the schema).
- [x] Committed as `✨ add message files and ticket reads`.

## Comments

- 2026-11-21, core: built as `✨ add message files and ticket reads`, migration `20261202100000_milestone_9`, after `20261201200000_preview_shared_notification`, the newest on `main` then. Readings and differences:
  - **The message intents' mapping:** `packages/db/src/enums.ts` has no mapping of intents of its own; the one that carries them is the held turn's origin (`turnOriginToDb`, whose keys are the intents that start a turn), so `ticket-update` joins `turnOriginSchema` (server-only, as `linear-follow-up` did in milestone 6), `HeldTurnOrigin` gains `ticket_update`, both maps carry it, and `turnOriginOfIntent("ticket-update")` is now its own origin (ticket 01 gave it `message`).
  - **A blob's deletion:** the composite keys to the blob (`blobId`/`textBlobId` with `organizationId`) keep a file to its organization's blobs, and `onDelete: SetNull` would null `organizationId` too, so the migration writes `ON DELETE SET NULL ("blobId")` (and `"textBlobId"`), Postgres 15's column list. Prisma warns at `generate` that a SetNull relation has a required field; `prisma migrate diff` sees no difference. The test deletes blobs and a whole task to prove both.
  - **`ticketWhere`** is text with a check (`description`, `comment`, `attachment`), since section 5.3's list of enums doesn't name one. `sha256` is nullable (a ticket's file never fetched has none), and `ticketSourceKey` and `sha256` are checked as lower-case hex SHA-256s, so a URL can't be stored as a key.
  - **Added beyond the table:** a unique place per task (`message_file_one_per_place`, on `(taskId, boxPath)` where set), and checks that an upload is a member's with no task, event or place; a sent file has its task, event, position, place and time; a ticket's file has no member and a task; a left-out or failed one, and a failed text, name their reason; a read's round counts from 1, its digest is a SHA-256 and its lists are arrays; a model's catalog inputs are an array. No check reads a blob column, so a task's deletion can take its blobs and files in either order. `COMMENT`s say the name, the place, the text and the source key are never logged.
  - **Isolation:** both models have builders in `@ostra/db/testing` (project models), and the readers table lists them with no procedure yet (ticket 14 adds theirs); `F-148/c3`'s case checks every leak check looks for their IDs in B and in the restricted project.
  - **Checks:** the whole repo's typecheck, lint and tests, with the same two failures on `origin/main` as ticket 01 notes (`e2e/dev-tools`, `packages/api`'s lint of `memory.ts`).
