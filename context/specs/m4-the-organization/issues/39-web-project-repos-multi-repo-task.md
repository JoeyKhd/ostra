# 39: Web: project repos, the task with several repos, and the check

Status: ready-for-agent
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

- [ ] Playwright, named `it("F-098: ...")` and `it("F-104: ...")`: a project admin adds a second repo and reorders; a removal of a repo in use is refused with the task named; a task with two PRs shows both with their check states, on the fake code host.
- [ ] Each screen checked by eye against its target, dark and light, at 1440 px and phone width.
- [ ] Committed as `✨ add several repos to the panel`.

## Decided 2026-11-19

Settled by the target's recommendation, on the maintainer's delegation (ticket 42, step 5); the maintainer may reopen any.

- **One repos page, under Settings** (`project-repos.md`): `/projects/[id]/settings/repos`; `/projects/[id]/repos` redirects to it, and the project sidebar's `Repos` row is dropped.
- **Project admins add repos** (`project-repos.md`): adding grants nothing the App doesn't already reach, and `projects.availableRepos` lists what the installation grants.

## Comments
