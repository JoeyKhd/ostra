import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { descendantsOf, listProcesses, watchProcessTree } from "@ostra/adapter-sdk";
import type { ExecutorCapabilities, TreeWatch } from "@ostra/adapter-sdk";
import { loadJobObjects } from "./job-object.ts";
import type { JobObjects, JobObjectsLoaderOptions } from "./job-object.ts";

// How the `host` executor ends every process of a task together (ADR 0029, Q126). A box's
// container does this by construction; on `host` it's one of:
//
// - `job-object`: on Windows, a job per task with kill-on-close, made through koffi
//   (`job-object.ts`). Everything the agent and the setup script start is in it, a helper that
//   detached itself and whose parent exited included, and the kernel ends it if the runner dies.
// - `cgroup`: on Linux with cgroup v2 and a cgroup the runner may write (a systemd user session
//   delegates one), each task gets its own cgroup, and `cgroup.kill` ends every process in it.
// - `process-tree`: everywhere else (macOS, Linux without a cgroup of its own, and Windows when
//   koffi can't load). Each process's group and tree are walked and snapshotted every second, and at
//   the end every process of the runner's user that carries the task's marker in its environment
//   (`OSTRA_TASK_UNIT`) is ended too. A process that both leaves its group and clears its
//   environment can escape: the panel says so.
//
// One unit per task: made with the task's workspace, joined by the setup script and the agent, and
// ended at stop and release.

export type ContainmentKind = ExecutorCapabilities["processContainment"];

/** The variable a task's processes carry their unit's marker in (ticket 42). Not a secret; never logged. */
export const TASK_UNIT_ENV = "OSTRA_TASK_UNIT";

/** What `adopt` needs to know about a process besides its PID. */
export type AdoptOptions = {
  /** Resolves when the process exits: its PID is never ended by number after that (PIDs are reused). */
  readonly exited?: Promise<unknown>;
};

/** One task's processes, as one unit. */
export type ContainmentUnit = {
  readonly kind: ContainmentKind;
  /** The value every process of the unit gets in `OSTRA_TASK_UNIT`. */
  readonly marker: string;
  /**
   * Puts a process in the unit. Call it in the same tick as `spawn`: its synchronous part assigns
   * the process (a job object), and the promise resolves once anything born before that is in too.
   */
  readonly adopt: (pid: number, options?: AdoptOptions) => Promise<void>;
  /** The PIDs in the unit now, when the unit can list them (a job, a cgroup); `null` when it can't. */
  readonly pids: (() => Promise<readonly number[]>) | null;
  /** Ends every process in the unit. The unit can take new processes after it. */
  readonly killAll: () => Promise<void>;
  /** Ends what's left, stops watching and removes what the unit made. */
  readonly dispose: () => Promise<void>;
};

export type Containment = {
  readonly kind: ContainmentKind;
  /** A unit for one task, with `marker` when the task has one kept already, else a new one. */
  readonly create: (name: string, marker?: string) => Promise<ContainmentUnit>;
};

/** A fresh marker: random, so no other task's process carries it. */
export const newUnitMarker = (): string => `ostra-unit-${randomBytes(12).toString("hex")}`;

/** How often the process-tree unit remembers each process's descendants. */
const SNAPSHOT_MS = 1_000;

const run = promisify(execFile);

/** Ends every process of the runner's own user that carries `marker` in its environment. */
export type MarkerSweep = (marker: string) => Promise<number>;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const killPid = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone, or not ours.
  }
};

/** The PIDs whose environment, as `/proc/<pid>/environ` holds it, carries `OSTRA_TASK_UNIT=marker`. */
export const markedInProc = async (procRoot: string, marker: string, uid: number | null): Promise<readonly number[]> => {
  const wanted = `${TASK_UNIT_ENV}=${marker}`;
  const entries = await readdir(procRoot).catch((): string[] => []);
  const found: number[] = [];
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        const pid = Number(entry);
        if (pid === process.pid) {
          return;
        }
        try {
          if (uid !== null && (await stat(path.join(procRoot, entry))).uid !== uid) {
            return;
          }
          const environ = await readFile(path.join(procRoot, entry, "environ"), "latin1");
          if (environ.split("\u0000").includes(wanted)) {
            found.push(pid);
          }
        } catch {
          // It exited, or isn't readable: not ours.
        }
      }),
  );
  return found;
};

/**
 * The PIDs `ps -E` shows with `OSTRA_TASK_UNIT=marker`, on macOS and the BSDs, where the
 * environment follows the command (unverified on a Mac: ticket 42's case).
 */
export const markedInPs = (psOutput: string, marker: string): readonly number[] => {
  const wanted = `${TASK_UNIT_ENV}=${marker}`;
  const found: number[] = [];
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || Number(match[1]) === process.pid) {
      continue;
    }
    if (match[2].split(/\s+/).includes(wanted)) {
      found.push(Number(match[1]));
    }
  }
  return found;
};

export type MarkerSweepOptions = {
  readonly platform?: NodeJS.Platform;
  /** Where Linux's process table is. */
  readonly procRoot?: string;
};

/**
 * The marker sweep of this machine: `/proc/<pid>/environ` on Linux, `ps -E` on macOS. Windows can't
 * read another process's environment without reading its memory, and a job object holds what a
 * marker would, so it ends nothing there. A few rounds, for a process that forked while it ran.
 */
export const localMarkerSweep = (options: MarkerSweepOptions = {}): MarkerSweep => {
  const platform = options.platform ?? process.platform;
  const procRoot = options.procRoot ?? "/proc";
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const find = async (marker: string): Promise<readonly number[]> => {
    if (platform === "linux") {
      return markedInProc(procRoot, marker, uid);
    }
    if (platform === "win32" || uid === null) {
      return [];
    }
    try {
      const { stdout } = await run("ps", ["-wwE", "-U", String(uid), "-o", "pid=,command="], {
        maxBuffer: 64 * 1024 * 1024,
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" },
      });
      return markedInPs(stdout, marker);
    } catch {
      return [];
    }
  };
  return async (marker) => {
    let ended = 0;
    for (let round = 0; round < 4; round += 1) {
      const pids = await find(marker);
      if (pids.length === 0) {
        break;
      }
      for (const pid of pids) {
        killPid(pid);
      }
      ended += pids.length;
      await wait(50);
    }
    return ended;
  };
};

type Root = { readonly watch: TreeWatch; exited: boolean };

export type ProcessTreeOptions = {
  /** The marker sweep at the end. Default: this machine's. */
  readonly sweep?: MarkerSweep;
};

/** The process-tree unit: every process's group and tree, and the task's marker. */
export const processTreeContainment = (options: ProcessTreeOptions = {}): Containment => {
  const sweep = options.sweep ?? localMarkerSweep();
  return {
    kind: "process-tree",
    create: (_name, given) => {
      const marker = given ?? newUnitMarker();
      const roots: Root[] = [];
      let timer: ReturnType<typeof setInterval> | undefined;
      const killAll = async (): Promise<void> => {
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
        for (const root of roots.splice(0)) {
          if (root.exited) {
            // Its PID may be another process's by now: only the descendants it was seen with.
            await root.watch.snapshot();
          } else {
            await root.watch.killAll();
          }
          await root.watch.reap();
        }
        await sweep(marker);
      };
      return Promise.resolve({
        kind: "process-tree",
        marker,
        pids: null,
        adopt: async (pid, adoptOptions = {}) => {
          const root: Root = { watch: watchProcessTree(pid), exited: false };
          roots.push(root);
          void adoptOptions.exited?.then(() => {
            root.exited = true;
          });
          await root.watch.snapshot();
          timer ??= setInterval(() => {
            for (const each of roots) {
              void each.watch.snapshot();
            }
          }, SNAPSHOT_MS);
          timer.unref();
        },
        killAll,
        dispose: killAll,
      });
    },
  };
};

/** `ostra-<8 hex of the runner's data folder>-`: two runners of one user don't touch each other's cgroups. */
export const cgroupPrefix = (owner: string): string => `ostra-${createHash("sha256").update(owner).digest("hex").slice(0, 8)}-`;

/**
 * Linux cgroup v2 containment under `parent`, the cgroup the runner was started in (or one it was
 * delegated). Each unit is a child cgroup; `cgroup.kill` (Linux 5.14+) ends all of it at once.
 */
export const cgroupContainment = (parent: string, options: { readonly prefix?: string; readonly sweep?: MarkerSweep } = {}): Containment => ({
  kind: "cgroup",
  create: async (name, given) => {
    const dir = path.join(parent, `${options.prefix ?? "ostra-"}${name.replace(/[^A-Za-z0-9_-]/g, "_")}`);
    await mkdir(dir, { recursive: true });
    // The tree too: a child forked before its parent was moved stays in the old cgroup.
    const tree = await processTreeContainment(options.sweep === undefined ? {} : { sweep: options.sweep }).create(name, given);
    const procs = async (): Promise<readonly number[]> => {
      const text = await readFile(path.join(dir, "cgroup.procs"), "utf8").catch(() => "");
      return text
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    };
    return {
      kind: "cgroup",
      marker: tree.marker,
      pids: procs,
      adopt: async (pid, adoptOptions) => {
        await writeFile(path.join(dir, "cgroup.procs"), `${String(pid)}\n`);
        await tree.adopt(pid, adoptOptions);
      },
      killAll: async () => {
        await writeFile(path.join(dir, "cgroup.kill"), "1\n");
        await tree.killAll();
      },
      dispose: async () => {
        await writeFile(path.join(dir, "cgroup.kill"), "1\n").catch(() => undefined);
        await tree.dispose();
        try {
          await rmdir(dir);
        } catch {
          // Still has a process for a moment after the kill: the kernel removes it once empty.
        }
      },
    };
  },
});

/** How long `killAll` waits for a job's process list to empty. */
const JOB_DRAIN_MS = 5_000;

/** The Windows unit: one job object per task (`job-object.ts`). */
export const jobObjectContainment = (jobs: JobObjects, options: ProcessTreeOptions = {}): Containment => ({
  kind: "job-object",
  create: async (name, given) => {
    const job = jobs.create();
    // For a process the job refused while it ran (it can't happen on Windows 8 and later, which
    // nest jobs): its tree, so it still ends with the task.
    const refused = await processTreeContainment(options).create(name, given);
    const drain = async (): Promise<void> => {
      const deadline = Date.now() + JOB_DRAIN_MS;
      while (job.pids().length > 0 && Date.now() < deadline) {
        await wait(25);
      }
    };
    return {
      kind: "job-object",
      marker: refused.marker,
      pids: () => Promise.resolve(job.pids()),
      adopt: (pid, adoptOptions) => {
        // Synchronously, before anything awaits: the same tick as `spawn`.
        if (!job.assign(pid)) {
          return refused.adopt(pid, adoptOptions);
        }
        // Anything it started before it was assigned: one tree snapshot, each assigned too.
        return listProcesses().then(
          (all) => {
            for (const child of descendantsOf(pid, all)) {
              job.assign(child.pid);
            }
          },
          () => undefined,
        );
      },
      killAll: async () => {
        job.terminate();
        await drain();
        await refused.killAll();
      },
      dispose: async () => {
        job.terminate();
        await drain();
        job.close();
        await refused.dispose();
      },
    };
  },
});

/** `0::/user.slice/...` from `/proc/self/cgroup`: the runner's own cgroup v2 path. */
export const ownCgroupPath = (procSelfCgroup: string): string | null => {
  for (const line of procSelfCgroup.split("\n")) {
    if (line.startsWith("0::")) {
      return line.slice(3).trim();
    }
  }
  return null;
};

export type ContainmentProbe = {
  readonly platform: NodeJS.Platform;
  /** Where cgroup v2 is mounted. */
  readonly cgroupRoot: string;
  /** The text of `/proc/self/cgroup`. */
  readonly readSelfCgroup: () => Promise<string>;
  /** How koffi is imported on Windows (`job-object.ts`). A test fakes a failure here. */
  readonly importKoffi?: JobObjectsLoaderOptions["importKoffi"];
  /** Told why the executor fell back to the process tree, for the runner's log. */
  readonly onFallback?: (reason: string) => void;
  /** The prefix of the runner's cgroups (`cgroupPrefix`). */
  readonly cgroupPrefix?: string;
  /** The marker sweep the process-tree unit ends with. Default: this machine's. */
  readonly sweep?: MarkerSweep;
};

const defaultProbe: ContainmentProbe = {
  platform: process.platform,
  cgroupRoot: "/sys/fs/cgroup",
  readSelfCgroup: () => readFile("/proc/self/cgroup", "utf8"),
};

type Delegated = { readonly ok: true; readonly parent: string } | { readonly ok: false; readonly reason: string };

/** The cgroup the runner may make children in, or why it can't. */
const delegatedCgroup = async (probe: ContainmentProbe): Promise<Delegated> => {
  try {
    const own = ownCgroupPath(await probe.readSelfCgroup());
    if (own === null) {
      return { ok: false, reason: "the runner isn't in a cgroup v2" };
    }
    const parent = path.join(probe.cgroupRoot, own);
    const test = path.join(parent, `ostra-probe-${String(process.pid)}`);
    await mkdir(test);
    try {
      await access(path.join(test, "cgroup.kill"));
    } finally {
      await rmdir(test);
    }
    return { ok: true, parent };
  } catch (error) {
    return { ok: false, reason: `the runner's cgroup isn't delegated to it (${error instanceof Error ? error.name : "unknown"})` };
  }
};

/**
 * The best containment this machine allows, checked once, when the executor starts: a job object
 * on Windows, a cgroup on Linux when the runner's cgroup is delegated to it (it can make a child
 * there, with `cgroup.kill`), and the process tree with the marker sweep otherwise. Every fallback
 * is told to `onFallback`, with its reason.
 */
export const detectContainment = async (given: Partial<ContainmentProbe> = {}): Promise<Containment> => {
  const probe: ContainmentProbe = { ...defaultProbe, ...given };
  const treeOptions: ProcessTreeOptions = probe.sweep === undefined ? {} : { sweep: probe.sweep };
  if (probe.platform === "win32") {
    const jobs = await loadJobObjects({ platform: probe.platform, ...(probe.importKoffi === undefined ? {} : { importKoffi: probe.importKoffi }) });
    if (jobs.ok) {
      return jobObjectContainment(jobs.value, treeOptions);
    }
    probe.onFallback?.(jobs.reason);
    return processTreeContainment(treeOptions);
  }
  if (probe.platform !== "linux") {
    probe.onFallback?.(`${probe.platform} has no kernel unit for a task's processes`);
    return processTreeContainment(treeOptions);
  }
  const cgroup = await delegatedCgroup(probe);
  if (!cgroup.ok) {
    probe.onFallback?.(cgroup.reason);
    return processTreeContainment(treeOptions);
  }
  return cgroupContainment(cgroup.parent, { ...treeOptions, ...(probe.cgroupPrefix === undefined ? {} : { prefix: probe.cgroupPrefix }) });
};

/**
 * What an earlier run of this runner left (ticket 42): its own cgroups on Linux, ended and removed,
 * and on Linux and macOS the processes that carry the marker of a task folder that still exists. On
 * Windows the kernel ended them already: the dead runner's handle closed its jobs.
 */
export const sweepLeftovers = async (options: {
  readonly probe?: Partial<ContainmentProbe>;
  /** The markers kept in the task folders that still exist. */
  readonly markers: readonly string[];
  readonly cgroupPrefix: string;
}): Promise<{ readonly cgroups: number; readonly processes: number }> => {
  const probe: ContainmentProbe = { ...defaultProbe, ...options.probe };
  if (probe.platform === "win32") {
    return { cgroups: 0, processes: 0 };
  }
  let cgroups = 0;
  if (probe.platform === "linux") {
    const own = await probe.readSelfCgroup().then(ownCgroupPath, () => null);
    if (own !== null) {
      const parent = path.join(probe.cgroupRoot, own);
      const entries = await readdir(parent).catch((): string[] => []);
      for (const entry of entries.filter((name) => name.startsWith(options.cgroupPrefix))) {
        const dir = path.join(parent, entry);
        await writeFile(path.join(dir, "cgroup.kill"), "1\n").catch(() => undefined);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            await rmdir(dir);
            cgroups += 1;
            break;
          } catch {
            await wait(50);
          }
        }
      }
    }
  }
  const sweep = probe.sweep ?? localMarkerSweep({ platform: probe.platform });
  let processes = 0;
  for (const marker of options.markers) {
    processes += await sweep(marker);
  }
  return { cgroups, processes };
};
