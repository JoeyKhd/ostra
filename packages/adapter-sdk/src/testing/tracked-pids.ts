import { isAlive, listProcesses, sameProcess } from "../agent/acp/process-tree.ts";
import type { ProcessKey } from "../agent/acp/process-tree.ts";

export type TrackedPids = {
  /** Remembers the process at `pid` now, by its birth as well as its PID. Gives `pid` back. */
  readonly track: (pid: number | null) => Promise<number | null>;
  /** Whether the process `track` saw at `pid` still runs: not just any process with that PID. */
  readonly isAlive: (pid: number) => Promise<boolean>;
};

/**
 * PIDs a test reads from a process it didn't start itself (a helper that wrote its own), told apart
 * by birth. Windows hands a dead process's PID to the next one it starts within moments, so after a
 * stop that took seconds, "is PID n alive?" can answer for another process, and a kill by that PID
 * would end it. Each check of a PID still in use lists the machine's processes, in the listing every
 * caller in the process shares (`shared-listing.ts`).
 */
export const trackedPids = (): TrackedPids => {
  const keys = new Map<number, ProcessKey>();
  return {
    track: async (pid) => {
      if (pid !== null && !keys.has(pid)) {
        const now = (await listProcesses().catch(() => [])).find((p) => p.pid === pid);
        if (now !== undefined && now.startedAt !== 0) {
          keys.set(pid, { pid: now.pid, name: now.name, startedAt: now.startedAt });
        }
      }
      return pid;
    },
    isAlive: async (pid) => {
      if (!isAlive(pid)) {
        return false;
      }
      const key = keys.get(pid);
      if (key === undefined) {
        return true;
      }
      const listed = await listProcesses().catch(() => undefined);
      return listed === undefined || listed.some((p) => sameProcess(p, key));
    },
  };
};
