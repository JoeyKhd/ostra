# 17: Core: several repos, and the related PRs

Status: resolved
Builder: core
Blocked by: 06, 08
Features: F-098
Packages: `packages/domain` (`addProjectRepo`, `removeProjectRepo`, `linkRelatedPullRequests`), `apps/core` (`src/dispatch/`, the PR opener, `src/reactions/`)
Spec: `../spec.md`, section 4 ("Several repos"); ADR 0027 (amended)

## What to build

- **A project's repos:** `addProjectRepo` checks the App can reach the repo (milestone 1's `listRepos` check), the limit of 10, and gives it the next `position`; `removeProjectRepo` refuses while an unfinished task has a branch in it, naming those tasks. Each is an audit entry.
- **The dispatch** puts every repo of the project in the spec in `position` order, each with its folder name (ticket 06's rule) and base branch. A task's open session keeps its repos; its next session gets a repo added since, with a new task repo and no branch.
- **One PR per repo that's ahead,** as milestone 1's opener does, then `pr.link-related` keyed by the task and the PR: it renders the "Related" section (ticket 06) and edits every open PR of the task with `updatePullRequestBody`, keeping the rest of each body, and writes `pr.related_updated`. A replay changes nothing.
- **The ticket** gets every PR linked through milestone 2's tracker writer, as it already does per PR.
- **The task's state** follows milestone 2's PR set rule; this ticket only checks it with two repos, both orders of the events.
- **The diff, checks, update branch and the fresh branch after a merge** stay milestone 3's, per repo; this ticket adds the tests with two repos.

## Done when

- [x] Tests named `it("F-098: ...")`: a spec with two repos in order; one branch name in both; a task that changes one repo opens one PR; two PRs each list the other, after a replayed webhook too; both linked on the ticket; one merged and one closed unmerged gives `merged`, both orders; a repo in use can't be removed; a repo added reaches the next session.
- [x] Break-it: the related-PR edit skipped for the first PR fails its test; recorded in `context/proof/F-098.md`.
- [x] Committed as `✨ add tasks across several repos`.

## Comments

- 2026-11-19: built and proved; committed as `✨ add tasks across several repos` (its hash is in `git log`). `addProjectRepo` (the App must list the repo through one of the organization's linked installations, the limit `OSTRA_PROJECT_MAX_REPOS`, the next `position`, the folder by ticket 06's rule), `removeProjectRepo` (refused while an unfinished task has a branch in the repo, with those tasks in the refusal's `tasks`; refused for the last repo) and `reorderProjectRepos` (for ticket 30), each with its audit entry, are `packages/domain/src/repos/project-repos.ts`. The spec already listed the task's repos in `position` order; a reopen's new session now gets a task repo with no branch for each repo the project gained (`addNewProjectReposInTx`), so an open session keeps its repos. Each PR the opener makes enqueues `pr.link-related` (keyed by task and PR); its handler (`apps/core/src/reactions/related-prs.ts`) reads each open PR's body from the host, sets its "Related" section with ticket 06's renderer, writes it only when it changed, and writes `pr.related_updated`: a replay changes nothing. Milestone 1's footer ("The task's other PRs") stays as it was. Removing a repo deletes its row, so finished tasks' task repos for it go too (the schema has no removed state for a repo). Ten break-its, each caught (`context/proof/F-098.md`). The diff, checks and update branch with two repos are left to tickets 39 and 41's runs. Tests: `apps/core/src/reactions/several-repos.test.ts`.
