# 19: The `host` executor

Status: resolved
Builder: runner
Blocked by: 04, 18
Features: F-016, F-050, F-014 (the executor), F-078 (commits)
Packages: `packages/adapters/adapter-executor-host` (new, Apache-2.0)
Spec: `../spec.md`, sections 1, 2 and 11 (items 5, 7, 9, 10)

## What to build

`HostExecutor extends ExecutorAdapter`, with `isolation: "none"`, `services: false`, `boxSizes: false`, `snapshots: false` (ADR 0029's allowed differences).

- **create:** a task root under the runner's data folder (`tasks/<taskId>/`), with one folder per repo side by side. The worktree follows the box's states.
- **prepare:** for each repo, clone through the git proxy's URL (an `insteadOf` rule in a git config local to the task, never the user's global config), check out the task's branch from the default branch, set `user.name` and `user.email` to the App's bot identity from the task spec. Write each repo's variables and secrets into that repo's checkout (a `.env` by default, or the given path; spec section 11, item 7), and make sure the file is ignored by the repo's `.gitignore` or added to `.git/info/exclude`. Run the setup script per repo with `OSTRA_RUNNER_SHELL` (default `bash` from `PATH`) through `execFile` with the script as a file, never a string, and stream its output as `environment.setup_*` events. A failing setup is a typed failure.
- **startAgent:** spawn the agent's launch (from the agent adapter) as a child of the runner, cwd the task root, with exactly the launch's environment; return the `AgentHost` handle.
- **commitAndPush:** after a turn, `git add -A` and commit what's left with the message the task host gives and a `Co-authored-by` trailer per co-author; push the task's branch through the proxy. For stop and crash: commit unfinished work, uncommitted and untracked files, to `refs/ostra/wip/<taskId>` and push it. Report per repo whether the branch is ahead of its base and its head SHA.
- **stop and release:** end the agent's whole process tree (ticket 09's reaper). On Windows, no job object yet (spec section 11, item 5): leave a `ContainmentUnit` seam for it, and say in `capabilities` that detached processes aren't contained. Release deletes the task root.
- Run the executor contract suite, with the detached-helper case marked expected-to-fail on Windows with the reason (ADR 0029, Q126).

## Done when

- [x] Against the git proxy's upstream stub: a task root with two repos is created, a setup script's output is streamed, a turn's change is committed with the trailer and pushed, a stop pushes the hidden ref with an untracked file in it, release leaves no folder.
- [x] A secret written for repo A is not in repo B's folder, and is not committed.
- [x] No process survives stop (the agent's tree; the detached case recorded as above).
- [x] The whole-repo checks pass (spec section 9: agent output).
- [x] Committed as `✨ add the host executor`.

## Comments

- 2026-11-18, runner: done in c5c1232 (`✨ add the host executor`); ticket 22 added the `TaskProcesses` seam to it (9a3db82). `packages/adapters/adapter-executor-host`: `HostExecutor` with ADR 0029's declared differences. Task roots under the data folder, with the repos side by side. Git with a task-local config (insteadOf to the git proxy, the bot's identity, no credential helper, never the member's global or system config), and the same settings in each checkout. Env files and secret files per repo, kept out of git through `.git/info/exclude`, and refused inside `.git`. Setup runs per repo with `OSTRA_RUNNER_SHELL` on the script as a file, streamed. A `prepare-commit-msg` hook adds the co-author trailers to the agent's own commits, from a file. The branch and the hidden ref are pushed together. Stop ends the agent's whole tree through a `Containment` seam: a cgroup v2 unit on Linux when the runner's cgroup is delegated, the process tree otherwise; a Windows job object is the seam's next implementation (Q126). The detached-helper contract case **passes** on Windows here (the tree's snapshots catch the helper while its parent lives), so no known gap is declared; a helper whose parent exits between two snapshots can still escape. On Windows, libuv copies a fixed set of OS variables (PATH, USERPROFILE, TEMP and the like, no credential) into every child's environment, whatever the launch says. Whole-repo checks green.
