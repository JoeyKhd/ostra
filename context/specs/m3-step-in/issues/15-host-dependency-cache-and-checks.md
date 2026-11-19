# 15: Host executor: the dependency cache, the mirrors and checks

Status: ready-for-agent
Builder: runner
Blocked by: 05
Features: F-051 (the `host` half), F-054, F-094 (the refusal)
Packages: `packages/adapters/adapter-executor-host`
Spec: `../spec.md`, sections 1 ("On this machine") and 4; ADR 0038 (amended), ADR 0029

## What to build

- **The repo mirrors:** per project and repo, a bare mirror under the runner's data folder (`cache/<projectId>/<repoId>.git`), fetched through the git proxy before each task, and each task's worktree cloned from it with `--reference` semantics, so a second task doesn't download the repo again. `GIT_CEILING_DIRECTORIES` on every git call (milestone 2's rule).
- **The dependency cache:** per project, one folder (`cache/<projectId>/deps/`) whose path the setup script receives as `OSTRA_DEPENDENCY_CACHE`, and the package managers' cache variables pointed into it (`npm_config_cache`, `PNPM_STORE_DIR`, `YARN_CACHE_FOLDER`, `PIP_CACHE_DIR`, `GOMODCACHE`, `CARGO_HOME`'s registry), so the setup's install is warm. Another project's tasks never see it.
- **`prepareCache`** returns the cache key and whether it was warm, and the task reports it (`dependency cache: warm`) with the setup's duration.
- **Clean-up:** the cache goes when the project is removed from the runner, or after 30 idle days *(working value)*; milestone 2's release removes only the worktree.
- **`runChecks`:** each check in the worktree (its repo's folder, or the workspace root), as a child process with the task's environment variables and nothing of the runner's own, through the async child-process API, with the timeout ending the process tree (milestone 1's tree reap) and the output written to a file.
- **Services:** `create` refuses a spec with services, with the reason ostra shows ("the `host` executor starts no services"), though the scheduler never sends one (ticket 27).

## Done when

- [ ] Tests: the executor contract suite (ticket 05) passes on Windows, with the second task's setup reading a warm cache and a second project's task not seeing it; checks pass, fail and time out with no process left behind.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the host dependency cache and checks`.

## Comments

- 2026-11-19: milestone 2's ticket 42 gives each task one containment unit on `host` (Q126; ADR 0029, "Process containment on `host`"). A check's process joins its task's unit, so what a check leaves running ends with the task, and the timeout's tree reap isn't the only thing that ends it.
