# 46: Contracts: linked installations, several Apps and a bot per repo

Status: done
Builder: core (contracts, first)
Blocked by: 01, 05, 06, 45 (its migration lands first)
Features: F-136, F-078
Packages: `packages/db` (`prisma/schema.prisma`, `prisma/migrations/`, `src/enums.ts`, `src/mappers.ts`, `src/testing/isolation-models.ts`), `packages/protocol` (`src/task-spec.ts`, in ticket 01's minor 3), `packages/domain` (`src/code-host/installations.ts` new, the use-case signatures)
Spec: `../spec.md`, section 5.5; ADR 0065

## What to build

- **The migration:** the installations half of section 5.5's table, after ticket 45's, additive only: `Connection.ownerLogin` and `ownerAccountId`, `CodeHostInstallation`, and the `Repo` foreign key to it. The backfill writes one `linked` row per installation an existing repo uses, linked by nobody, so the key holds for every existing row.
- **The protocol,** in minor 3 (ticket 01): `TaskSpec.repos[]` gains an optional `gitIdentity`, the bot of that repo's App. The minor-2 encoding drops it and keeps the top-level `gitIdentity`.
- **The domain:**
  - `installationUsable(row)`: linked and not removed, the one rule every token mint and repo listing asks
  - `linkOwnInstallation`: an installation on the App owner's own account is linked when seen
  - `linkInstallation`, `unlinkInstallation`, `removeInstallation`, `connectExistingApp`, each an organization admin's, each with its audit entry (`installation.linked`, `installation.unlinked`, `installation.removed`, `connection.added`)
  - the dispatch rule: a task whose repos have different bots needs a minor-3 runner (`needs-protocol`)
- **The isolation list** (ticket 09) gains `CodeHostInstallation`.

## Done when

- [x] `pnpm db:migrate` applies to an empty database and to one at ticket 45's head with repos on one installation; after it, every existing repo's installation is linked.
- [x] Tests named `it("F-136: ...")`:
  - the `Repo` key refuses an installation with no row
  - `installationUsable` is false for a removed or unknown installation
  - linking another organization's installation is refused
  - each use case writes its audit entry
- [x] Protocol tests: a spec with a git identity per repo round-trips, and its minor-2 encoding keeps only the top-level one.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the linked-installation contracts`.

## Comments

- 2026-11-19: migration `20261121020000_linked_installations` (`Connection.ownerLogin` and `ownerAccountId`, `CodeHostInstallation`, and `Repo`'s composite key to it, put on after the backfill writes one `linked` row per installation an existing repo uses). Domain in `packages/domain/src/code-host/installations.ts`: `installationUsable`, `linkOwnInstallation`, `linkInstallation`, `unlinkInstallation`, `removeInstallation` (uninstalls through a port before the commit), `connectExistingApp`, each with its audit entry in its transaction, and `requiredRunnerMinor` for the dispatch rule. The protocol's `TaskSpec.repos[].gitIdentity` and `taskSpecNeedsMinor3` landed with ticket 01 (6786658). Every place that creates a repo row directly now gives it its installation row: `createProject` upserts it (as before milestone 4, the installation the repo was listed through is used; ticket 49 makes it linked-only), and tests use `seedInstallation` from `@ostra/db/testing`. Tests: `packages/db/src/schema-installations.test.ts`, `packages/api/src/services/installations.test.ts`, with break-its; proof rows in `context/proof/F-136.md`. The isolation list of ticket 09 doesn't exist yet, so ticket 09 adds `CodeHostInstallation` when it builds it. Commit: `✨ add the linked-installation contracts`.
