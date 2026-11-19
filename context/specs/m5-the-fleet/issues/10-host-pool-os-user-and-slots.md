# 10: Host executor: a pool's OS user, and slots

Status: ready-for-agent
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

- [ ] Tests named for `F-015` and `F-014`: the `sudo` argument array for each kind of process; the Windows refusal; the missing-user refusal; the development switch refused when `NODE_ENV` is `production`.
- [ ] Break-it: running setup scripts as the runner's own user fails `F-015`'s test; recorded in `context/proof/F-015.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the host pool's agent user`.

## Comments
