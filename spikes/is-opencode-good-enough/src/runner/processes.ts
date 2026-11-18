// Every process a run spawns and that may still be alive, for the final sweep.
// The sweep kills only this run's own:
//   - a PID this process spawned (the agent, and every child `exec` starts),
//     killed only if the live process was created then (a PID reused by
//     another program is left alone);
//   - anything whose command line holds one of this run's folders;
//   - whatever was created by a process this harness spawned, while that
//     process lived: an agent's test that forked a loop, or a helper that
//     outlived its parent (on Windows `taskkill /T` follows live parent links
//     only, so these escape it, and a relative-path command line names no
//     folder). A child created after its parent ended belongs to whoever
//     reused the parent's PID, and is left alone.

import { killTree, listProcesses, type ProcessInfo } from "../lib/process-tree.ts";
import { WORK_ROOT } from "./sandbox.ts";

export type TrackedProcess = { readonly pid: number; readonly spawnedAt: number };

/** When a PID this process spawned began, and when it ended (undefined while it runs). */
export type SpawnSpan = { readonly spawnedAt: number; readonly endedAt: number | undefined };

/** The children alive right now. */
const spawned = new Map<number, TrackedProcess>();
/** Every PID this process ever spawned: how a process whose parent has exited is still known to be a descendant. */
const everSpawned = new Map<number, SpawnSpan>();

export const trackPid = (pid: number, spawnedAt = Date.now()): void => {
  if (pid > 0) {
    spawned.set(pid, { pid, spawnedAt });
    everSpawned.set(pid, { spawnedAt, endedAt: undefined });
  }
};

/** The child has ended: it is no longer one to look for by itself, but what it created while it lived still traces back to it. */
export const untrackPid = (pid: number): void => {
  spawned.delete(pid);
  const span = everSpawned.get(pid);
  if (span !== undefined && span.endedAt === undefined) everSpawned.set(pid, { spawnedAt: span.spawnedAt, endedAt: Date.now() });
};

export const trackedProcesses = (): readonly TrackedProcess[] => [...spawned.values()];

const SPAWN_WINDOW_MS = 5000;
/** A child's creation time may fall this far after its parent's end was seen (the parent's exit is noticed when its pipes close). */
const END_SLACK_MS = 1000;

/** The programs an agent's work runs as. A console host or an editor that shares a PID by chance is never swept. */
const TOOL_NAME = /^(opencode|node|git|tsc|bash|sh|cmd|npm|npx|pnpm|powershell|pwsh)(\.exe|\.cmd)?$/i;

export type OwnedProcess = {
  readonly process: ProcessInfo;
  /** Why it is this harness's: its command line names a harness folder, it is a child still running, or it was created by one. */
  readonly reason: "folder" | "tracked" | "descendant";
};

export type OwnershipInput = {
  readonly processes: readonly ProcessInfo[];
  /** Children spawned and still running, by PID: the spawn time. */
  readonly active: ReadonlyMap<number, number>;
  /** Every PID ever spawned, by PID. */
  readonly ever: ReadonlyMap<number, SpawnSpan>;
  readonly folders: readonly string[];
  readonly selfPid: number;
};

/** Which of the live processes belong to this harness. Pure, so it can be tested on a made-up process table. */
export const findOwned = (input: OwnershipInput): OwnedProcess[] => {
  const { processes, active, ever, folders, selfPid } = input;
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const owned = new Map<number, OwnedProcess>();

  for (const p of processes) {
    if (p.pid === selfPid) continue;
    const spawnedAt = active.get(p.pid);
    if (spawnedAt !== undefined && TOOL_NAME.test(p.name) && p.startedAt !== 0 && Math.abs(p.startedAt - spawnedAt) <= SPAWN_WINDOW_MS) owned.set(p.pid, { process: p, reason: "tracked" });
    else if (folders.some((folder) => p.commandLine.includes(folder))) owned.set(p.pid, { process: p, reason: "folder" });
  }

  const descendsFromOurs = (p: ProcessInfo): boolean => {
    if (!TOOL_NAME.test(p.name)) return false;
    if (owned.has(p.ppid)) return true;
    const span = ever.get(p.ppid);
    if (span === undefined || p.startedAt === 0) return false;
    // Created before its parent was spawned: the PID was reused.
    if (p.startedAt < span.spawnedAt - SPAWN_WINDOW_MS) return false;
    // Created after its parent ended: the PID was reused, and this is the new owner's child.
    if (span.endedAt !== undefined && p.startedAt > span.endedAt + END_SLACK_MS) return false;
    // The parent's PID is alive and was created at another time: another program has it now.
    const parent = byPid.get(p.ppid);
    return !(parent !== undefined && parent.startedAt !== 0 && Math.abs(parent.startedAt - span.spawnedAt) > SPAWN_WINDOW_MS);
  };

  for (let grew = true; grew; ) {
    grew = false;
    for (const p of processes) {
      if (p.pid === selfPid || owned.has(p.pid) || !descendsFromOurs(p)) continue;
      owned.set(p.pid, { process: p, reason: "descendant" });
      grew = true;
    }
  }
  return [...owned.values()];
};

/** The processes still alive that belong to these folders, to this process's task folders, or descend from what it spawned. */
export const findLeftovers = async (folders: readonly string[]): Promise<OwnedProcess[]> => {
  const active = new Map(trackedProcesses().map((t) => [t.pid, t.spawnedAt]));
  const processes = await listProcesses().catch((): ProcessInfo[] => []);
  return findOwned({ processes, active, ever: everSpawned, folders: [...folders, WORK_ROOT], selfPid: process.pid });
};

/** Kills what `findLeftovers` finds, and returns how many. */
export const sweep = async (folders: readonly string[]): Promise<number> => {
  const leftovers = await findLeftovers(folders);
  for (const { process: p } of leftovers) await killTree(p.pid);
  return leftovers.length;
};
