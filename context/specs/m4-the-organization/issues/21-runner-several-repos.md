# 21: Runner: several repos side by side

Status: ready-for-agent
Builder: runner
Blocked by: 01
Features: F-098
Packages: `apps/runner` (`src/task-host/`, `src/sidecar/git-proxy/`), `packages/adapters/adapter-executor-host`, `packages/adapters/adapter-executor-docker`
Spec: `../spec.md`, section 4 ("Several repos"); ADR 0027 (amended)

## What to build

Most of this exists (spec section 1): the spec's `repos` list, the git proxy per repo, `agentCwd` at the root for several, per-repo results in `session.ended`. This ticket makes two repos work end to end and proves it.

- **Checkout:** every repo of the spec cloned into its folder under the workspace, in order, on the task's one branch name, with its own git token behind the git proxy; on `host` from milestone 3's per-project mirror when it exists.
- **The agent's instructions** carry the list of repos, their folders and base branches, which core appended to `agent.instructions` (ticket 15); the runner checks the folders match the spec's.
- **After a turn:** each repo committed, checked (milestone 3's checks with their `repoId`), and pushed only when it's ahead; the hidden ref and the session archive cover every repo; `session.saved` and `session.ended` report each repo.
- **Reopen:** a fresh box restores every repo from its hidden ref, and a repo new to the task is cloned at its base.
- **Containment:** the agent's reach is the workspace, which holds all the task's repos and nothing of another task's (ADR 0029 on `host`).

## Done when

- [ ] Tests named `it("F-098: ...")` on `host` with two bare repos: both checked out side by side; one branch name; a turn that changes one pushes one; a turn that changes both pushes both; a reopen on a fresh worktree restores both; the git proxy refuses a push to the other task's branch in either repo.
- [ ] The same cases against the `docker` executor's fake engine.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ check out several repos side by side`.

## Comments
