# 15: Host executor: the dependency cache, the mirrors and checks

Status: done
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

- [x] Tests: the executor contract suite (ticket 05) passes on Windows, with the second task's setup reading a warm cache and a second project's task not seeing it; checks pass, fail and time out with no process left behind.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the host dependency cache and checks`.

## Comments

- 2026-11-19: milestone 2's ticket 42 gives each task one containment unit on `host` (Q126; ADR 0029, "Process containment on `host`"). A check's process joins its task's unit, so what a check leaves running ends with the task, and the timeout's tree reap isn't the only thing that ends it.
- 2026-11-19, milestone 2's builder of ticket 42: built. The unit is the box record's `unit` in `HostExecutor`; a program joins it by passing it as `unit` in `runProgram`'s options (`RunOptions.unit`), which adopts the process in the same tick as its spawn. Each process of the unit also gets `OSTRA_TASK_UNIT`, the marker the process-tree unit sweeps by.
- 2026-11-19, runner: done in `✨ add the host dependency cache and checks` (008cb77). **The cache:** `cache/<projectId>/` holds a bare mirror per repo (`<repoId>.git`, fetched through the git proxy with an empty global config, no credential helper and `GIT_CEILING_DIRECTORIES`), `deps/`, the key and `last-used`. A box whose spec says `host-cache` runs `prepareCache` first (one update per project at a time), clones each repo with `--reference-if-able <mirror> --dissociate`, so its worktree owns its objects and a removed mirror breaks no worktree, and gives the setup `OSTRA_DEPENDENCY_CACHE` and the package managers' variables. A new key empties `deps/` and keeps the mirrors. A cache that couldn't be made never fails the setup: the box clones and installs in full. `environment.setup_finished` gains `dependencyCache: warm | cold` (minor 2, dropped for an older peer, in the contracts commit `✨ add setup cache fields and commitWork`, 80f733f). `host` now declares `snapshots: "host-cache"`. **Clean-up:** `sweepIdleCaches` at start and at most hourly after, skipping a project with a live box; `removeProjectCache(projectId)` refuses while a box of the project is live. No runner command says a project left a runner yet, so nothing calls it; the 30-day sweep covers that case until one exists. **Checks:** `runChecks` runs each through the setup shell in the task's unit with `checkEnvironment` only; `runProgram` now ends the whole tree on an abort (it used to end only the shell), with its own process group on Linux and macOS. **Services:** refused with `the `host` executor starts no services` before a box is made. Proof: F-051's `host` row (proved), F-094's `host` row (proved, with the scheduler's half), F-054's run row (partial until ticket 32). Break-it checks: five (the cache variables dropped, one folder for every project, the idle window doubled, the tree reap undone, the refusal dropped), plus the runner reporting every cache cold; each failed its test.
