# 04: DB: the milestone 8 migration

Status: ready-for-agent
Builder: core (contracts, first)
Blocked by: none
Features: F-121, F-140, F-141, F-142, F-143, F-144, F-145, F-146 (their tables)
Packages: `packages/db`
Spec: `../spec.md`, section 5.3

## What to build

One new migration, after milestone 7's, additive only: the tables, columns and enums of spec section 5.3's table, exactly. Every row carries `organizationId`. Every project record carries `projectId` with the composite key to the project, as milestone 4's rule says.

- **The new models,** each with its indexes:
  - `AppProcess`, with its partial unique index for the primary;
  - `TaskAttachment`, `TaskPreview`, `PreviewAccess`, `PreviewAccessMember`, `PreviewLink`, `PreviewView` and `PreviewCode`;
  - `LibraryItem`, `LibraryItemVersion`, `AgentProfileLibraryItem`, `LibrarySource` and `LibrarySuggestion`.
- **The new columns:**
  - `Service.previewLabel`;
  - `Environment`'s three screenshot columns;
  - `Task.previewId`;
  - `Box.previewWatchedAt`;
  - `Lease.purpose` and `appStartedByMemberId`;
  - `OrganizationSetting`'s two switches.
- **The enums** of section 5.3's last row.
- **Doc comments** (`///`) that say which columns are never logged: a command, a caption, a note, a token's hash, a server's inputs.
- **Milestone 4's generated isolation test** gets a fixture for every new model, and fails until each has one.
- **No backfill.** Every environment has no app process, every task no preview ID, every lease the purpose `turn`, and both organization switches are off. The registry source is seeded by ticket 06's job, not here.

## Done when

- [ ] The migration applies to a database at milestone 7's schema and to an empty one, and `prisma migrate diff` against the schema is empty.
- [ ] The isolation test passes with a fixture for each new model (break-it: remove one fixture, and the test fails naming the model).
- [ ] A test inserts a second primary process in one environment and is refused by the index.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the milestone 8 migration`.

## Comments
