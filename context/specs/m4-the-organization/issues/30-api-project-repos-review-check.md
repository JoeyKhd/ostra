# 30: API: project repos and the review check

Status: resolved
Builder: api
Blocked by: 17, 18
Features: F-098, F-104
Packages: `packages/api` (`src/routers/projects.ts`, `src/routers/tasks.ts`)
Spec: `../spec.md`, section 4 ("Several repos", "The independent-review check"); ADR 0027 (amended), ADR 0040 (amended)

## What to build

- **`projects.repos`** (any member who can open the project): the repos in order, each with its default branch, its warnings (milestone 2's branch rules) and the unfinished tasks using it.
- **`projects.addRepo`, `projects.removeRepo`, `projects.reorderRepos`** (project admin): ticket 17's use cases; a refusal of a removal lists the tasks by key or title.
- **Project creation** (`projects.create`) takes one or more repos.
- **`tasks.get`** gains, per task repo, every PR it has had (milestone 3's `TaskPullRequest`) and the PR's review check (`ReviewCheck`: waiting or passed, its reason, the approver).

## Done when

- [x] Tests named `it("F-098: ...")`: add, reorder and remove with their access and limits; a removal refused with the tasks named; a project created with two repos.
- [x] Tests named `it("F-104: ...")`: the check's state and reason on `tasks.get` per repo and head.
- [x] Committed as `✨ add project repos and the check to the API`.

## Comments

- 2026-11-19 (api builder B): built and pushed as `✨ add project repos and the check to the API`. `projects.repos`, `projects.addRepo`, `projects.removeRepo` (a refusal answers `{ removed: false, message, tasks }`, each task by title and ticket key) and `projects.reorderRepos` in `packages/api/src/routers/project-repos.ts`, over ticket 17's use cases with `OSTRA_PROJECT_MAX_REPOS`. `projects.create` takes `moreRepos` (`createProjectInputSchema`, additive), each repo once, the limit checked in the router; `checkProjectRepos` and the project views now order repos by `position`. `tasks.get` gives each PR a `reviewCheck` (`waiting`/`passed`, reason, approver, and `heads`). Tests: `project-repos.test.ts`, `task-review-check.test.ts`, and the isolation suite's new `projects.repos` row; break-its in `context/proof/F-098.md` and `F-104.md`.
