# 10: Host executor: a pool's OS user, and slots

Status: done
Builder: adapters
Blocked by: 02
Features: F-015, F-014, F-095
Packages: `packages/adapters/adapter-executor-host` (`src/host-executor.ts`, `src/agent-user.ts` (new), `src/containment.ts`, `src/host-executor.live.test.ts` (new))
Spec: `../spec.md`, sections 1 ("On this machine") and 11, item 13; ADR 0029 (amended)

## What to build

- **A pool's separate OS user** (ADR 0029, amended): on Linux and macOS, a `host` executor in a pool runner starts the agent, its setup script and its checks as `OSTRA_HOST_POOL_AGENT_USER` through `sudo -n -u <user> --`, with the command as an argument array, never a shell string. The worktree is made by the runner and handed to that user (owner and mode), and the runner's own data folder, its key and its temp folder are unreadable to it. `health()` checks that `sudo -n -u` works for that user and for no other, and that the user can't read the runner's key.
- **Refusals:** a `host` pool runner on Windows refuses to start: "A host pool runs the agent as a separate OS user, which this release supports on Linux and macOS". A `host` pool runner without the setting refuses with the fix. `OSTRA_DEV_HOST_POOL_SAME_USER=true` (development and test only, checked again here) runs as the runner's user and makes `health()` report it, so the panel says "same user (development only)".
- **Containment with the separate user:** the cgroup on Linux, and on macOS the marker sweep over the agent user's processes rather than the runner's.
- **Slots:** `capacity()` is `null`; the runner reports `capacity` as slots; a size is refused (ticket 02).
- **The live file** for ticket 35: on Linux, the agent user made in the job, a shell in the agent's process that can't read the runner's key or another task's worktree, the delegated cgroup killed as a unit, and the detached helper ended; on macOS, the marker sweep's two cases (ADR 0029's consequences).

## Done when

- [x] Tests named for `F-015` and `F-014`: the `sudo` argument array for each kind of process; the Windows refusal; the missing-user refusal; the development switch refused when `NODE_ENV` is `production`.
- [x] Break-it: running setup scripts as the runner's own user fails `F-015`'s test; recorded in `context/proof/F-015.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the host pool's agent user`.

## Comments

- 2026-11-20: built. `src/agent-user.ts`: `hostPoolAgentUser` decides who a pool's tasks run as, or why the pool runner doesn't start (the development switch refused when `NODE_ENV` is `production`, else the runner's own user on any system; Windows; no `OSTRA_HOST_POOL_AGENT_USER`; a name `sudo` could read as a flag; the runner's own user). `agentUserProcesses` sends every process of a task through `sudo -n -u <user> [--preserve-env=<names>] -- <command> <args...>`: the agent, the setup script, the checks, and the git that makes the worktree too, so what the task makes is the agent's from the start. `HostExecutor.startPool` gives the executor that user, hands each task's folder to the agent's group (setgid directories, group-writable, `handOverToGroup`, no root needed: the admin adds the runner's user to that group), makes the data folder traversable only, and sweeps the agent user's processes as that user (`agentUserMarkerSweep`: its `/proc` on Linux, `ps -wwE` on macOS, `kill -KILL` through sudo), with the cgroup on Linux as before; release removes what the agent made as the agent. `health()` checks that the rule works for that user, not for `root`, and that the user can't read the runner's key (the runner passes its key's path), and on the development switch answers `degraded` with "same user (development only)", which the runner prints and runs on. `capacity()` stays `null` (slots) and a size is refused (ticket 02). The runner starts a pool's `host` executor through `startPool` (`apps/runner/src/run-runner.ts`) and stops with the reason when it refuses. `docs/configuration.md` gives the sudoers rule. Choices: the variables reach the agent by name through `--preserve-env` (the rule's `SETENV`), never as values in an argument; the rule also sets `umask=0007` for that user, so the runner can still write the git files it adds after a clone. Not settled here: one agent user serves all of a pool's tasks on a machine, so two running tasks can read each other's worktrees there; Q293 in `context/open-questions.md` asks whether to take a user per slot. The live file `src/host-executor.live.test.ts` (ticket 35's Linux and macOS jobs) checks a shell in the agent's process is the agent's user and can't read the runner's key or a folder the runner kept, the cgroup killed as a unit on Linux, and the macOS sweep's two cases. Proof: `context/proof/F-015.md` (the host pool row, `partial` until those jobs and ticket 31's panel line) and `F-014.md`; break-its: the setup script run as the runner's own user (`runProgram` in place of the seam) failed the sudo test, and the Windows, missing-user and production refusals each failed their test when let through, as did `kill` run as the runner in the sweep. Commit: `✨ add the host pool's agent user`.
