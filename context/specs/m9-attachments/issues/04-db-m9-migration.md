# 04: DB: the milestone 9 migration

Status: ready-for-agent
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

- [ ] The migration applies on an empty database and on one at milestone 8's last migration, and `prisma migrate diff` shows nothing else.
- [ ] Tests named for `F-148/c3`: the isolation test's every-record case covers both models.
- [ ] Checks for the whole repo pass (spec section 10: the schema).
- [ ] Committed as `✨ add message files and ticket reads`.

## Comments
