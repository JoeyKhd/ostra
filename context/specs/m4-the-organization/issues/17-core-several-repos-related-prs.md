# 17: Core: several repos, and the related PRs

Status: ready-for-agent
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

- [ ] Tests named `it("F-098: ...")`: a spec with two repos in order; one branch name in both; a task that changes one repo opens one PR; two PRs each list the other, after a replayed webhook too; both linked on the ticket; one merged and one closed unmerged gives `merged`, both orders; a repo in use can't be removed; a repo added reaches the next session.
- [ ] Break-it: the related-PR edit skipped for the first PR fails its test; recorded in `context/proof/F-098.md`.
- [ ] Committed as `✨ add tasks across several repos`.

## Comments
