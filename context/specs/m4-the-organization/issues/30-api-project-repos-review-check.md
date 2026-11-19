# 30: API: project repos and the review check

Status: ready-for-agent
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

- [ ] Tests named `it("F-098: ...")`: add, reorder and remove with their access and limits; a removal refused with the tasks named; a project created with two repos.
- [ ] Tests named `it("F-104: ...")`: the check's state and reason on `tasks.get` per repo and head.
- [ ] Committed as `✨ add project repos and the check to the API`.

## Comments
