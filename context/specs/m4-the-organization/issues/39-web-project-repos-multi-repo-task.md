# 39: Web: project repos, the task with several repos, and the check

Status: resolved
Builder: web
Blocked by: 30, 31
Features: F-098, F-104
Packages: `apps/web` (`src/app/(panel)/projects/[project-id]/settings/repos/`, `src/app/(panel)/projects/new/`, `src/task/`, the environment page)
Spec: `../spec.md`, sections 3 (steps 3 to 5) and 12; target `project-repos`

## What to build

- **Repos** in the project's settings to the `project-repos` target: the repos in order, drag to reorder (and a keyboard way), "Add repo" from the App's installed repos, a repo in use with the tasks that block its removal, the limit.
- **Project creation** with one or more repos, growing `app-targets/m1/project-new`.
- **The environment** shows a section per repo, growing `app-targets/m1/environment`.
- **The task page** for several repos, growing `app-targets/m1/task`, `m3/task-changes` and `m3/task-checks`: every PR in the header, each with its repo, state and `ostra/independent-review` state ("Waiting for an independent reviewer", "Only drivers approved", "Approved by Sam"); the Changes and Checks tabs grouped by repo.
- Write the growing changes under `## Comments`.

## Done when

- [x] Playwright, named `it("F-098: ...")` and `it("F-104: ...")`: a project admin adds a second repo and reorders; a removal of a repo in use is refused with the task named; a task with two PRs shows both with their check states, on the fake code host.
- [x] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [x] Committed as `✨ add several repos to the panel`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **One repos page, under Settings** (`project-repos.md`): `/projects/[id]/settings/repos`; `/projects/[id]/repos` redirects to it, and the project sidebar's `Repos` row is dropped.
- **Project admins add repos** (`project-repos.md`): adding grants nothing the App doesn't already reach, and `projects.availableRepos` lists what the installation grants.

## Comments

- 2026-11-20, web builder B: Settings › Repos (`/projects/[id]/settings/repos`, `components/projects/project-repos.tsx`) to the `project-repos` target: the repos in order with their position, branch-rule checks and "In use by N tasks", a drag handle that also takes ↑ and ↓ (`projects.reorderRepos`, saved at once), "Add repo" from the linked installations' repos (`github.reposByAccount`, `projects.addRepo`, disabled at `OSTRA_PROJECT_MAX_REPOS`), and the panel with the repo's checks, its position and folder, the tasks that hold it, and "Remove from project", whose refusal names those tasks. `/projects/[id]/repos` redirects there and the project sidebar's Repos row is gone (decided 2026-11-19); the repo links of the project panel and the check lines point at it. Growing screens: New project takes one repo or several, in the order picked (`moreRepos`), each numbered once there are two; the task header lists each repo's PR with its state and `ostra/independent-review` in words ("Waiting for an independent reviewer", "Only drivers approved", "Approved by Sam"). The environment page already had a section per repo, and the Changes tab already groups files by repo; the Checks tab keeps milestone 3's repo chip on each check row rather than a group per repo. The e2e stack's fake GitHub gains a second repo, `fake-org/test2`, in the same installation. Proof: `apps/web/e2e/16-repos.spec.ts` (two-repo project, add, keyboard reorder kept across a reload, the refused removal naming its task, the two PRs with their checks, phone width), with break-its on a rebuilt panel, and `project-repos.test.ts`; see `context/proof/F-098.md` and `F-104.md`. Checked by eye at 1440 px and 412 px in the dark theme against `project-repos.webp` (finals in the session's `ui-check/m4-project-repos-*-final.png`, `m4-task-prs-final.png`); the panel has no light theme yet. Commit: see the git log for `✨ add several repos to the panel`.
