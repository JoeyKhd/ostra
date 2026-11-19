# Research: ending every process of a task on the `host` executor

**Status:** Research, 2026-11-19. Settles Q126 (`open-questions.md`). Feeds ADR 0029 ("Process containment on `host`"), ADR 0007 (the dependency), F-014 and milestone 2's ticket 42.
**Method:**
- I read the docs and source I cite on 2026-11-19: Microsoft's pages on job objects and nested jobs, libuv's `src/win/process.c`, Node's `node:ffi` page and the 26.9.0 release notes, koffi's site, and the npm registry (`npm view`).
- I ran one throwaway probe on this machine, Windows 11 with Node 24.14.0 on x64, in a scratch folder outside the repo. Its script is in section 3, whole, so it can be run again. Every result marked **run** is that probe's.
- Nothing ran on macOS or Linux: I have neither here. What I say about them is from docs or from the code already in `packages/adapters/adapter-executor-host`, and is marked **unverified** where no run backs it.
- It builds on spike 1's finding (`spike-how-should-the-runner-drive-opencode.md`, surprise 5 and item 6), which saw the gap and didn't close it.

## Facts (checked 2026-11-19)

| Thing | Version, date | License | Note | Source |
|---|---|---|---|---|
| `koffi` | 3.3.8, 2026-11-13 | MIT | A C FFI for Node on Node-API 8, so one build serves every Node version. Needs Node 16 or later. 1.8 MB unpacked | `npm view koffi`; https://koffi.dev/ |
| `@koromix/koffi-win32-x64`, `@koromix/koffi-win32-arm64` | 3.3.8 | MIT | The prebuilt binary for one platform, an optional dependency of `koffi` limited by `os` and `cpu`. 1.1 MB unpacked for x64 | `npm view @koromix/koffi-win32-x64` |
| `node:ffi` | added in Node 26.1.0; on by default from 26.9.0 | Node's own | **Stability 1, experimental.** No struct type: a struct is a buffer the caller lays out. Refused under the permission model without `--allow-ffi` | https://nodejs.org/api/ffi.html; https://nodejs.org/en/blog/release/v26.9.0 |
| The `ostra` CLI's minimum Node | 24.5 (22.21 on the 22 line) | | So `node:ffi` isn't there for the runner's supported range | ADR 0046 |
| Nested jobs | Windows 8 and Windows Server 2012 | | Before them a process could be in one job only | https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs |

## 1. What each system gives

**Windows: a job object.** A job is a kernel object that holds processes. A child of a process in a job is in the job too, from its first instruction, and "if the immediate job object does not allow breakaway, the child process does not break away even if jobs in its parent job chain allow it" ([Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)). A job made with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` ends every process in it when its last handle closes, and `TerminateJobObject` ends them on request. So a job per task, held by the runner, is what a box's container is on `docker`: one unit that ends together.

**Node already uses one, and it doesn't help.** libuv puts every child it spawns that isn't detached into one global job with kill-on-close, "so windows will kill it when the parent process dies". It sets `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` on that job, "so only the processes that we explicitly add are affected, and their subprocesses are not" ([libuv, `src/win/process.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)). So the agent itself dies with the runner, and everything the agent starts doesn't. That is the gap spike 1 saw from the outside.

**A job per task nests under libuv's.** The agent is in libuv's job when `spawn` returns. Adding it to a second, empty job makes that job a child of libuv's, which Windows 8 and later allow (the nested jobs page, "Creating a Nested Job Hierarchy"). The task's job doesn't allow breakaway, so it is the immediate job of everything the agent starts, and the rule quoted above keeps those processes in it.

**Linux: a cgroup.** `cgroup.kill` ends a cgroup and its descendants at once (spike 1 cites the kernel's page). The executor does this already when the runner's own cgroup is delegated to it, and falls back to walking the process tree when it isn't (`containment.ts`, `detectContainment`). ADR 0029 said "a cgroup per task" and didn't record the fallback.

**macOS: nothing of the kind.** No cgroups and no job objects. A process group is ended with one signal, and a process leaves its group with `setsid`. What an unprivileged program can still do is find its own: a child keeps its parent's environment unless it clears it, and `ps -E` shows the environment of the caller's own processes (**unverified** here: no Mac).

## 2. How a Node runner makes a job object: the choices

| Choice | For | Against |
|---|---|---|
| **A. `koffi`, called from the runner** | TypeScript only (ADR 0008). No compiler on the member's machine: the binary is prebuilt and picked by `os` and `cpu`. The runner holds the handle, so it can list the job's processes and end them, and the kernel ends them if the runner dies. `node:ffi` can replace it later with the same six calls | A native binary in the runner's process on Windows. A wrong prototype would crash the runner, so the six prototypes are fixed and tested. The agent is added to the job just after it starts, not before (section 3) |
| B. A small helper program ostra builds (`open-questions.md`'s recommendation) | Nothing foreign in the runner's process. The helper joins its job before it starts the agent, so there is no instant outside it | A second language and a Windows build for x64 and arm64, shipped inside the CLI. An unsigned `.exe` of ostra's own, which ADR 0046 keeps out of v1 for exactly that reason. The runner can't ask the job what is in it without a second channel to the helper. One more process per task |
| C. An addon of ostra's own | The runner holds the handle | Everything against B, plus a native build per Node-API version to keep |
| D. `node:ffi` | No dependency at all | Experimental, and absent from Node 24 and 22, which the CLI supports |
| E. PowerShell with `Add-Type` | Nothing to install | Compiles C# at each start, and is refused by constrained language mode, which locked-down machines use (**unverified**: from memory, not run) |

**Chosen: A.** B's one real advantage is the instant between `spawn` and the assignment, which section 3 measures at about a tenth of a millisecond, far less than a program needs to start and spawn a child of its own. Its costs are a build pipeline, a second language and an unsigned binary. A's cost is one MIT dependency of 3 MB on Windows that loads nowhere else.

## 3. The probe (run)

In a scratch folder: `npm install koffi@3.3.8 --ignore-scripts`, which added 2 packages (`koffi` and `@koromix/koffi-win32-x64`) and ran no install script. The binary loaded without it.

The script makes a job with kill-on-close, starts an "agent" (a Node process), and adds it to the job in the same tick as `spawn`, before the event loop turns. The agent starts a helper that detaches itself, prints the helper's PID and exits, so the helper's parent is gone before any tree snapshot could see it.

```js
const { spawn, execFileSync } = require("node:child_process");
const koffi = require("koffi");

const k32 = koffi.load("kernel32.dll");
const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
const CreateJobObjectW = k32.func("__stdcall", "CreateJobObjectW", HANDLE, ["void *", "str16"]);
const SetInformationJobObject = k32.func("__stdcall", "SetInformationJobObject", "bool", [HANDLE, "int", "void *", "uint32_t"]);
const QueryInformationJobObject = k32.func("__stdcall", "QueryInformationJobObject", "bool", [HANDLE, "int", "void *", "uint32_t", "void *"]);
const OpenProcess = k32.func("__stdcall", "OpenProcess", HANDLE, ["uint32_t", "bool", "uint32_t"]);
const AssignProcessToJobObject = k32.func("__stdcall", "AssignProcessToJobObject", "bool", [HANDLE, HANDLE]);
const TerminateJobObject = k32.func("__stdcall", "TerminateJobObject", "bool", [HANDLE, "uint32_t"]);
const CloseHandle = k32.func("__stdcall", "CloseHandle", "bool", [HANDLE]);

const createJob = () => {
  const job = CreateJobObjectW(null, null);
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes on x64, LimitFlags at offset 16.
  const info = Buffer.alloc(144);
  info.writeUInt32LE(0x2000 /* JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE */, 16);
  SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, info, info.length);
  return job;
};

const assign = (job, pid) => {
  const proc = OpenProcess(0x0001 /* PROCESS_TERMINATE */ | 0x0100 /* PROCESS_SET_QUOTA */, false, pid);
  AssignProcessToJobObject(job, proc);
  CloseHandle(proc);
};

const jobPids = (job) => {
  const buffer = Buffer.alloc(8 + 8 * 1024); // JOBOBJECT_BASIC_PROCESS_ID_LIST
  QueryInformationJobObject(job, 3 /* JobObjectBasicProcessIdList */, buffer, buffer.length, null);
  return Array.from({ length: buffer.readUInt32LE(4) }, (_, i) => Number(buffer.readBigUInt64LE(8 + 8 * i)));
};

const job = createJob();
const agent = spawn(process.execPath, ["-e", AGENT_SCRIPT], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
assign(job, agent.pid); // the same tick as spawn()
```

The agent's script, in the two ways the probe started the helper:

```js
// by Node
spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
// by a shell
spawn("cmd.exe", ["/d", "/c", "start", "/b", "", process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }).unref();
```

| Case | Result (run) |
|---|---|
| Control, no job: the agent exits, then `taskkill /PID <agent> /T /F` | **The helper survives.** The tree kill has no tree left to walk. This is spike 1's T13 again |
| A job, then `TerminateJobObject` | The helper was alive and in the job's process list. After the call it was gone and the list was empty |
| A job, then closing its last handle | The helper was gone: kill-on-close |
| The helper started through `cmd /c start /b` | 2 processes in the job, none left after `TerminateJobObject` |
| The process holding the job is killed hard (`TerminateProcess`) | The helper was gone. The kernel closed the dead process's handle, and the job with it |
| The time from `spawn` returning to the agent being in the job | 107 µs |

**What the probe doesn't show.**
- A child the agent started before the assignment would be outside the job. The agent's program would have to load, start and spawn within about a tenth of a millisecond. OpenCode takes tens of milliseconds to start (inferred from its size, not measured). The executor keeps one tree snapshot at the assignment as a second wall.
- A program that asks for `CREATE_BREAKAWAY_FROM_JOB` fails to start its child inside a job that doesn't allow breakaway (from the docs, not run). libuv doesn't ask for it, and says why in a comment. A tool that insists on it would fail on a Windows `host` runner and not in a box.
- Windows on arm64: the struct is the same 144 bytes (inferred from the field types), and koffi ships that binary, but nothing ran there.
- Whether an antivirus or an application allowlist refuses koffi's binary. When it can't load, the executor has to fall back and say so (section 5).

## 4. macOS, and Linux without a cgroup

The runner can't close this with a kernel unit, so it adds one more sweep to what it has.

- **The agent's process group.** The agent starts as a group leader (`detached: true`), and one signal ends everyone still in the group, orphans included. The executor does this today.
- **The descendants it saw.** A tree snapshot each second, so a child whose parent has since exited is still known. The executor does this today.
- **A marker in the environment, new.** The launch gets one more variable, a random value made for the task's unit. A child inherits it unless it clears its environment. When the unit ends, the runner lists its own user's processes with their environments (`/proc/<pid>/environ` on Linux, `ps -E` on macOS) and ends every one that carries the marker. The spike 1 harness found its stray helper the same way, by a marker.

**What still gets out:** a process that both leaves the group and drops its environment, and a process started for the agent by something that was already running (`launchd`, an editor's server, a Docker daemon). The second gets out of a cgroup and a job object too, and only a box holds it (ADR 0031).

All of this section is **unverified** on a Mac. The contract case for it runs on one before F-014 is `done`.

## 5. What this changes in the plan

1. **ADR 0029, process containment:** Windows uses a job object per task through `koffi`, held by the runner. macOS keeps the process group and the tree and gains the marker sweep. Linux uses its cgroup, and the same marker sweep when it has none. The third allowed difference is reworded: weaker containment wherever the machine gives no kernel unit, which the runner reports and the panel shows.
2. **ADR 0007:** `koffi` 3.3.8 for the runner, on Windows only. It replaces the row "a way to make a Windows job object from Node".
3. **F-014:** its "done when" names the three mechanisms and the Mac run.
4. **The executor's capability** `processContainment` already has `job-object`. The runner has to tell the server which one it has, because the panel's line about detached processes depends on it and no longer on the operating system.
5. **Revisit when** the CLI's minimum Node has `node:ffi` out of experimental. The same six calls move to it, and `koffi` leaves.

## Built (2026-11-19, milestone 2's ticket 42)

The probe is ported as `packages/adapters/adapter-executor-host/src/job-object.ts`, with the same seven functions and layouts, an unnamed `HANDLE` type (koffi refuses a type name declared twice in one process) and one job made and closed when it loads. Its tests ran on this machine (Windows 11 x64, Node 24.14.0): `context/specs/m2-tickets-in/evidence/42-windows-containment.txt`. One correction to section 3's control: a **tree walk** (not `taskkill /T`) still finds a helper whose parent exited, because Windows keeps the dead parent's PID on its children. What the walk can't reach is a helper whose parent and grandparent both exited, and the tests use that case. The macOS case (section 4) hasn't run: it waits for a Mac.
