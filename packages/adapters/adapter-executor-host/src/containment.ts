import { access, mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { killTree, watchProcessTree } from "@ostra/adapter-sdk";
import type { ExecutorCapabilities } from "@ostra/adapter-sdk";

// How the `host` executor ends every process of a task together (ADR 0029, Q126). A box's
// container does this by construction; on `host` it's one of:
//
// - `cgroup`: on Linux with cgroup v2 and a cgroup the runner may write (a systemd user session
//   delegates one), each task gets its own cgroup, and `cgroup.kill` ends every process in it, a
//   detached one included.
// - `process-tree`: everywhere else, Windows included until a job-object helper is approved (Q126).
//   The agent's tree is walked and snapshotted every second, so a child whose parent already exited
//   is still known; a process that detached itself between two snapshots can escape.
//
// A Windows job object is the seam's next implementation: `ContainmentUnit` is what it fills.

export type ContainmentKind = ExecutorCapabilities["processContainment"];

/** One task's processes, as one unit. */
export type ContainmentUnit = {
  readonly kind: ContainmentKind;
  /** Puts the agent's process in the unit, right after it started. */
  readonly adopt: (pid: number) => Promise<void>;
  /** Ends every process in the unit. */
  readonly killAll: () => Promise<void>;
  /** Stops watching, and removes what the unit made. */
  readonly dispose: () => Promise<void>;
};

export type Containment = {
  readonly kind: ContainmentKind;
  readonly create: (name: string) => Promise<ContainmentUnit>;
};

/** How often the process-tree unit remembers the agent's descendants. */
const SNAPSHOT_MS = 1_000;

export const processTreeContainment = (): Containment => ({
  kind: "process-tree",
  create: () => {
    let watch: ReturnType<typeof watchProcessTree> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let root: number | undefined;
    return Promise.resolve({
      kind: "process-tree",
      adopt: async (pid) => {
        root = pid;
        watch = watchProcessTree(pid);
        await watch.snapshot();
        timer = setInterval(() => {
          void watch?.snapshot();
        }, SNAPSHOT_MS);
        timer.unref();
      },
      killAll: async () => {
        if (timer !== undefined) {
          clearInterval(timer);
        }
        if (watch !== undefined) {
          await watch.killAll();
          await watch.reap();
        } else if (root !== undefined) {
          await killTree(root);
        }
      },
      dispose: () => {
        if (timer !== undefined) {
          clearInterval(timer);
        }
        return Promise.resolve();
      },
    });
  },
});

/**
 * Linux cgroup v2 containment under `parent`, the cgroup the runner was started in (or one it was
 * delegated). Each unit is a child cgroup; `cgroup.kill` (Linux 5.14+) ends all of it at once.
 */
export const cgroupContainment = (parent: string): Containment => ({
  kind: "cgroup",
  create: async (name) => {
    const dir = path.join(parent, `ostra-${name.replace(/[^A-Za-z0-9_-]/g, "_")}`);
    await mkdir(dir, { recursive: true });
    // The tree watch too: a child the agent forked before it was moved stays in the old cgroup.
    const tree = await processTreeContainment().create(name);
    return {
      kind: "cgroup",
      adopt: async (pid) => {
        await tree.adopt(pid);
        await writeFile(path.join(dir, "cgroup.procs"), `${String(pid)}\n`);
      },
      killAll: async () => {
        await writeFile(path.join(dir, "cgroup.kill"), "1\n");
        await tree.killAll();
      },
      dispose: async () => {
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
};

const defaultProbe: ContainmentProbe = {
  platform: process.platform,
  cgroupRoot: "/sys/fs/cgroup",
  readSelfCgroup: () => readFile("/proc/self/cgroup", "utf8"),
};

/**
 * The best containment this machine allows: a cgroup on Linux when the runner's cgroup is
 * delegated to it (it can make a child cgroup there, with `cgroup.kill`), the process tree
 * otherwise. Checked once, when the executor starts.
 */
export const detectContainment = async (probe: ContainmentProbe = defaultProbe): Promise<Containment> => {
  if (probe.platform !== "linux") {
    return processTreeContainment();
  }
  try {
    const own = ownCgroupPath(await probe.readSelfCgroup());
    if (own === null) {
      return processTreeContainment();
    }
    const parent = path.join(probe.cgroupRoot, own);
    const test = path.join(parent, `ostra-probe-${String(process.pid)}`);
    await mkdir(test);
    try {
      await access(path.join(test, "cgroup.kill"));
    } finally {
      await rmdir(test);
    }
    return cgroupContainment(parent);
  } catch {
    return processTreeContainment();
  }
};
