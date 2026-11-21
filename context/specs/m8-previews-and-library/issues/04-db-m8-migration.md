# 04: DB: the milestone 8 migration

Status: done
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

- [x] The migration applies to a database at milestone 7's schema and to an empty one, and `prisma migrate diff` against the schema is empty.
- [x] The isolation test passes with a fixture for each new model (break-it: remove one fixture, and the test fails naming the model).
- [x] A test inserts a second primary process in one environment and is refused by the index.
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✨ add the milestone 8 migration`.

## Comments

- 2026-11-21, core: built as `✨ add the milestone 8 migration`, in `20261201120000_milestone_8`, after `main`'s newest (`20261201000000_webhook_automations`, then ticket 01's `20261201100000_command_minor_7`). Readings and differences:
  - **Two source enums:** a library item's `sourceKind` (`github`, `well_known`, `registry`) and an allowlist source's `kind` (`github_owner`, `github_repo`, `well_known_host`, `registry`) are different sets, so the item's is `LibraryItemSourceKind` beside the spec's `LibrarySourceKind`.
  - **Names once among the installed:** an item's name is unique per organization and kind while `removedAt` is unset (`library_item_one_name`), so a removed item frees its name. A source is unique per `(organizationId, kind, value, namespace)`, and a second index (`library_source_one_without_namespace`) keeps it once when the namespace is `null`, since Postgres counts two `null`s as different.
  - **Keys beyond the table:** each project record's relation to its task, environment, repo, access row or link is composite with `projectId`; a named person is a `Member` of the same organization; an attachment's blob is the organization's (`(blobId, organizationId)`). `currentVersionId` is a plain key to the version, `ON DELETE SET NULL`, since a composite one would null `organizationId` too. `TaskPreview` is unique per `(taskId, key)`; `TaskAttachment` is indexed by `(taskId, createdAt)`, a link and a view by `(taskId, key)`, a code by `expiresAt` for the sweep.
  - **Checks Prisma can't declare** (marked `ostra:`): an app process's port is 1024 or above and its `readyValue` is set unless the kind is `port`; a task's `previewId` is 26 base32 characters; a link expires unless it's public, and a revoke names its member; a view and a code name a member or a link, and a CLI ticket a member; a closed view has its time; an attachment of a port has no name, a recording has its length, a member's names its member; an `app` lease alone names who started it; a version's number is positive; a decided version, a removed item and a decided suggestion name who and when.
  - **Never logged:** the `///` comments and `COMMENT ON COLUMN` say so for a command, a ready command, a caption, a link's and a code's hash, a server's inputs, a skill's files and a suggestion's note.
  - **`prisma migrate diff`** from a database with every migration to the schema holds nothing of milestone 8: its only statements re-create three older partial indexes (`event_turn_boundary`, `session_one_active_per_task`, `task_one_active_code_task_per_ticket`), whose `IN` lists Postgres keeps as `= ANY`. That noise is the same on `main` before this migration; `schema-m8.test.ts` checks the diff holds those three and nothing else.
  - **The isolation fixtures** build all 13 new models (8 inside a project); the guard in `isolation-models.test.ts` fails naming any model with `organizationId` that has no builder. The API's isolation suite lists them with no reader yet (tickets 16, 20 and 30 add theirs).
  - **Callers:** milestone 7's upgrade test now expects the task's new `previewId`, unset, as it does `project.repoSkills`. Break-it passes are dropped (the maintainer, 2026-11-21).
  - **Checks:** the whole repo's typecheck; lint of db and api; db's tests and the API's isolation suite.
