# 42: A job object on Windows, and a marker sweep where there's no kernel unit

Status: ready-for-human
Builder: runner; api and web for the one line in the panel
Blocked by: 02 (the protocol's minor 1)
Features: F-014
Packages: `packages/adapters/adapter-executor-host` (`src/containment.ts`, a new `src/job-object.ts`, `src/task-processes.ts`, `package.json`), `packages/adapter-sdk` (`src/agent/acp/process-tree.ts`, the executor contract suite), `packages/adapters/adapter-opencode` (the launch's allowlist), `packages/protocol` (`status`, one optional field), `packages/db` (one additive column on `Runner`), `apps/core`, `packages/api` (`routers/runners.ts`), `apps/web`, `apps/web/messages/en.json`, `pnpm-lock.yaml`
Spec: `../spec.md`, section 7 (follow-ups); ADR 0029, "Process containment on `host`"; `context/research/host-process-containment.md`

## Why

Settled as Q126 on 2026-11-19 (`context/open-questions.md`, Settled). On `host`, a process that left the agent's tree outlives the task: milestone 1's Windows executor walks the tree, and a helper whose parent has exited isn't in it. The research note has the run that shows the gap and the fix on this machine.

## What to build

- **The dependency:** `koffi` 3.3.8, pinned exactly, in `@ostra/adapter-executor-host`, in the same commit as `pnpm-lock.yaml` (ADR 0007). It is loaded by a dynamic import inside the job-object module, on `win32` only, so no other system loads it. It installs with install scripts off: its prebuilt `@koromix/koffi-win32-*` package is enough. `pnpm check:licenses` passes (MIT).
- **The job-object unit,** the `ContainmentUnit` that ticket 19 left the seam for:
  - `create` makes a job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  - `adopt(pid)` opens the process and assigns it **in the same tick as `spawn`**, so `localProcesses` adopts before it waits for the `spawn` event, and takes one tree snapshot for anything born in between
  - `killAll` calls `TerminateJobObject`, then waits until the job's process list is empty
  - `dispose` closes the handle
  - the six `kernel32` prototypes and the struct's layout live in one file, each with a test
- **One unit per task, and everything the task starts joins it.** Today the unit is made when the agent starts, and holds the agent only. It is made when the task's workspace is, the setup script's process joins it too, so a daemon the script starts ends with the task, and it is ended at stop, crash and release. Milestone 3's checks join it when they are built, which that ticket's comments now say (`../../m3-step-in/issues/15-host-dependency-cache-and-checks.md`).
- **Cancelling a turn:** where the unit can list its processes, the driver's "born since the turn started" reap takes them from that list, so a detached one is ended too.
- **`detectContainment`:** on Windows the job object. When `koffi` can't load or the job can't be made, the process tree, with a warning in the runner's log that names the reason. Linux and macOS as today.
- **The marker sweep,** for the process-tree unit on Linux and macOS: the unit makes a random marker, the launch carries it as `OSTRA_TASK_UNIT` (the agent adapter's allowlist gains the name), and `killAll` also ends every process of the runner's own user whose environment holds it (`/proc/<pid>/environ` on Linux, `ps -E` on macOS). The marker isn't a secret, and its value still stays out of log lines.
- **What a dead runner left:** when it starts, the runner ends what an earlier run of it left behind: its `ostra-*` cgroups on Linux, and on Linux and macOS the processes that carry the marker of a task folder that still exists. On Windows the kernel did it already.
- **Reporting it:** the runner's `status` carries `processContainment` (optional, additive: the minor 1 of ticket 02, in a commit of its own that names the contract). Core stores it on the runner, and `runners.list` and `runners.mine` return it. The line under Your machine appends "A process the agent detaches isn't contained." when the runner reports `process-tree`, whatever its system (`context/brand/app-targets/m1/runners.md`).
- **The contract suite:** the detached-helper case loses its known gap on Windows. A second case, a helper that also clears its environment, is the recorded gap of a `process-tree` unit, and passes on `job-object`, `cgroup` and `container`.

## Done when

- [x] On Windows: the detached-helper case passes with no known gap, with a helper whose parent exits at once. Killing the runner's process leaves no process of the task (a test with a child runner). A test shows `koffi` isn't imported on Linux.
- [x] With the loader faked to fail: the executor falls back to the tree, reports `process-tree`, and the panel's line shows.
- [x] On Linux with no cgroup of its own (the probe faked): a helper that left the agent's group is ended by its marker.
- [ ] macOS: the same case, run on a Mac, recorded under `## Comments` and in `context/research/host-process-containment.md`. Until it has run, F-014 isn't `done`.
- [x] A setup script that leaves a daemon behind: the daemon ends with the task, on Windows and on Linux.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] The whole-repo checks pass (spec section 9: anything that runs agent output).
- [x] Committed as `✨ contain a host task's processes`.

## Comments

- 2026-11-19, the builder: built in the commits `✨ add processContainment to minor 1's status` (the protocol's contract, alone) and `✨ contain a host task's processes`. `job-object.ts` ports the research note's probe: seven kernel32 prototypes and the two struct layouts, each with a test, and koffi imported by `import()` on `win32` only (koffi 3.3.8, `allowBuilds: koffi: false`). One unit per task, made in `create` with the task's folder (its marker kept in `unit-marker`); the setup script (`RunOptions.unit`) and the agent join it in the same tick as their spawn, and it ends at stop and release. A cancelled turn's reap also takes the unit's list (`AgentProcess.unitPids`). `HostExecutor.start` logs `containment.fallback` with its reason, and ends what an earlier run left (its own `ostra-<hash>-` cgroups, and the markers of the task folders still there). The status carries `processContainment` at minor 1, core stores it on `runner.processContainment` (migration `20261119230000_runner_process_containment`), `runners.mine` and `runners.list` return it, and the line under Your machine keys on `process-tree`. The contract suite has the second case (`cleanEnvHelper`), a known gap of the host suite only when it detects `process-tree`; the detached-helper case lost its gap on Windows. The panel accepts `OSTRA_TASK_UNIT` in the server's environment (an agent may run ostra's own server).
- Windows proof: `context/specs/m2-tickets-in/evidence/42-windows-containment.txt`, and break-it checks in `context/proof/F-014.md`. A finding while proving it: Windows keeps a dead parent's PID on its children, so a tree walk still finds a helper whose parent exited; the case that only a job object ends is a helper whose parent and grandparent both exited (`testing/helpers.ts`), and the tests use that.
- Not yet ticked: the Linux case with the cgroup probe faked and the setup daemon on Linux are written and run in CI on Linux, not on this Windows machine; the Mac case needs a Mac. F-014 stays `building`.
- 2026-11-19, the builder: the Linux half ran in CI on `ubuntu-latest`: run https://github.com/JoeyKhd/ostra/actions/runs/44450873472 (commit `a10e816`, which holds `✨ contain a host task's processes`) passed `pnpm test`, with `host-containment.test.ts`'s Linux-only case (the cgroup probe faked, the helper ended by its marker) and the setup daemon, the detached grandchild and the killed runner on the runner's process tree and marker. Ticked the Linux and setup-daemon boxes on that run. The Mac case is still open.
- 2026-11-20, audit: left open, now `ready-for-human`. Every box holds on `origin/main` except the macOS case, and nothing more can be done for it on this Windows machine: it needs a Mac. Milestone 5's ticket 35 already scripts it, as the `live-macos` job of the manual `Proof` workflow (`scripts/live/macos.sh`: the marker sweep ends a helper that left the group, and a helper that also cleared its environment is the recorded gap). **The maintainer's step:** `gh workflow run Proof -f jobs=fleet`; then an agent keeps the job's log in `context/specs/m5-the-fleet/demo/macos/`, records the result here and in `context/research/host-process-containment.md`, ticks the box, and F-014 can move on from `building`.
