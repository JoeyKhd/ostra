# 46: A project's branch names are unique in the database

Status: done
Builder: core
Blocked by: 05 (so this migration follows milestone 2's)
Features: F-016
Packages: `packages/db` (a unique index, in a migration of its own), `packages/domain` (`use-cases/create-prompt-task.ts`, and `startTicketTask` once ticket 29 has written it)
Spec: `../spec.md`, section 7 (follow-ups) and section 11 (item 5); `../../m1-first-pr/spec.md`, section 11 (item 10)

## Why

Settled as Q136, item 10, on 2026-11-19 (`context/open-questions.md`, Settled). A branch is named from the last 8 hex digits of the task's ID and a slug of its title. Two tasks of a project share a branch only with the same title and the same 32 random bits, which is rare and not impossible: a schedule that starts the same title every night makes the same title ordinary. Nothing in the database stops it, and F-016 says two tasks never share a branch. A shared branch would put one task's commits on another's PR.

## What to build

- **A unique index** on `task (projectId, branchName)`. Creating a task writes the placeholder `pending` first and the real name after, in one transaction: either the index leaves the placeholder out (a partial index, in raw SQL), or the create is reordered so it never writes one.
- **On a conflict,** the create takes four more hex digits of the task's ID (12, then 16) and tries again, inside the same transaction.
- **Fresh branches after a merge** are milestone 3's (ADR 0052: the old name with `-2`, then `-3`). They are made from this name, and go through the same check when milestone 3's ticket 24 makes them, which that ticket's comments now say (`../../m3-step-in/issues/24-core-behind-update-branch-after-merge.md`).
- **The migration** applies to a database that holds milestone 1's demo data. If an install somehow holds two tasks with one branch name, it names them and stops, and never renames a branch that is already on a code host.

## Done when

- [x] Tests: two tasks forced to the same name, with a faked ID suffix, end with different branches; the index refuses a hand-made duplicate; two creates at the same moment don't block each other on the placeholder.
- [x] The migration applies to an empty database and to one holding milestone 1's demo data.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] The whole-repo checks pass (spec section 9: the schema).
- [x] Committed as `✨ make branch names unique per project`.

## Comments
- 2026-11-19, core: done in `✨ make branch names unique per project` (1deaaa0).
  - **The index:** `task_project_branch_unique` on `task (projectId, branchName) WHERE "branchName" <> 'pending'`, declared in `schema.prisma` and made in migration `20261119230100_task_branch_unique`. The migration first looks for two tasks of a project with one branch, and stops with an error that names them, the project and the branch; it renames nothing.
  - **The create:** `claimBranchNameInTx` (`packages/domain/src/use-cases/create-prompt-task.ts`) sets the name under a savepoint, and on a refusal by that index (SQLSTATE 23505 naming it) rolls back to the savepoint and tries 12, then 16 hex digits (`BRANCH_ID_DIGITS`), in the caller's transaction. `startTicketTask` (ticket 29) isn't written yet: it calls `claimBranchNameInTx` the same way.
  - Test seeds that wrote one fixed branch name for every task (`seedTask` in `packages/api/src/testing/world.ts`, `newTask` in `packages/db/src/schema.test.ts`) now write a random 8-digit part, as a real task's ID gives.
  - Tests: `packages/api/src/routers/branch-names.test.ts`, `packages/db/src/schema.test.ts` and `packages/db/src/migrations.test.ts` (an empty database; one migrated to milestone 1's schema with the demo's rows, then the rest; one with a shared branch). Proof: F-016's third row, `partial` (the box and the working tree wait for F-017).
- 2026-11-20, audit: **done**; every box held already, only the status was never set. What the comment left for later is in too: the ticket start shares the prompt start's body, `packages/domain/src/starts/start-task-body.ts`, which names every task's branch through `claimBranchNameInTx` (a ticket's with `ticketBranchWith(key)`), and so does `apps/core/src/starts/outside.ts`; milestone 3's fresh branch after a merge (`packages/domain/src/use-cases/fresh-branch.ts`, `freshBranchesInTx`) skips every name another task of the project holds. Re-run today: `packages/api/src/routers/branch-names.test.ts` passes.
