# 21: Runner: several repos side by side

Status: done
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

- [x] Tests named `it("F-098: ...")` on `host` with two bare repos: both checked out side by side; one branch name; a turn that changes one pushes one; a turn that changes both pushes both; a reopen on a fresh worktree restores both; the git proxy refuses a push to the other task's branch in either repo.
- [x] The same cases against the `docker` executor's fake engine.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ check out several repos side by side`.

## Comments

- 2026-11-19: done in `✨ check out several repos side by side` (f8a1485). Most of it was there (spec section 1); this adds the folder check and the proof. `apps/runner/src/task-host/repo-folders.ts`: before anything is cloned, the runner checks no two repos share a folder (case aside) and that the `## Repositories` list core appends to the instructions names the spec's folders, in order; a mismatch crashes the session with both lists. The cases are in `apps/runner/src/testing/several-repos-cases.ts`, run by `several-repos.host.test.ts` and `several-repos.docker.test.ts` (8 each): side by side on one branch with the agent at the root, one changed repo pushes one, both push both, a reopen on another runner fetches and applies each repo's hidden ref and clones a repo new to the task at its base, the git proxy refuses another task's branch in either repo and takes the task's own, each repo's own git token, each task's workspace its own, and the folder check. The `docker` file runs the task host on `DockerExecutor` through the real bridge to a local init (`apps/runner/src/testing/docker-box.ts`, the harness's new `makeExecutor`); the box's containers and volume on the fake engine are `box-dispatcher.test.ts` and `box-per-task.test.ts`, as before. Eight break-its on `host`, four of them again on `docker`, each failed its case (`context/proof/F-098.md`). The host mirror path (milestone 3's per-project cache) is unchanged and per repo, proved by `host-cache-and-checks.test.ts`. Checks: typecheck, lint and test of `@ostra/runner` through turbo, `check:proof`, `check:licenses`. Merged with ticket 17's core rows in `context/proof/F-098.md`: rows 2, 4 and 5 are `proved`; rows 1 and 3 stay `partial` for the live two-repo run (ticket 41) and the per-repo diff and checks on the task page (ticket 39).
