import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// Replicas by name, for the failure suite (milestone 6's ticket 37, spec section 8): several
// processes of one service on one database, each started, killed with its whole tree as `kill -9`
// does (`taskkill /T /F` on Windows, SIGKILL to its process group elsewhere), stopped gracefully,
// and started again under the same name. A replica prints one JSON object a line on stdout (its
// "ready" line, a kill point's last words) and takes one JSON command a line on stdin; its stderr
// goes to its log file. The command and its arguments are fixed by the harness, never untrusted text.

const windows = process.platform === "win32";

/** How to start one replica. */
export type ReplicaSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Whether a stdout line says the replica is up. */
  readonly ready: (line: unknown) => boolean;
  /** Where its stderr (and its stdout) go, appended. */
  readonly logFile: string;
  readonly readyTimeoutMs?: number;
};

export type Replica = {
  readonly name: string;
  readonly pid: number;
  /** Resolves when it has exited, however it ended. */
  readonly exited: Promise<void>;
  readonly alive: () => boolean;
  /** Every JSON line it printed on stdout, oldest first. */
  readonly lines: readonly unknown[];
  /** Calls `listener` with each JSON line it prints from now on. */
  readonly onLine: (listener: (line: unknown) => void) => void;
  /** Writes one JSON command to its stdin. */
  readonly send: (command: object) => void;
  /** Ends it and everything under it at once, then waits for it to be gone. */
  readonly kill: () => Promise<void>;
  /** Sends `{ "stop": true }` and waits for it to exit, or kills it after `timeoutMs`. */
  readonly stop: (timeoutMs?: number) => Promise<void>;
};

/** Ends a process and everything under it, at once. */
export const killTree = (pid: number): Promise<void> =>
  new Promise((resolve) => {
    if (windows) {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        resolve();
      });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    resolve();
  });

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Starts one replica and waits for its ready line. */
export const startReplica = async (name: string, spec: ReplicaSpec): Promise<Replica> => {
  await mkdir(path.dirname(spec.logFile), { recursive: true });
  const log = createWriteStream(spec.logFile, { flags: "a" });
  const child = spawn(spec.command, [...spec.args], {
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Off Windows each replica leads its own process group, so its whole tree can be signalled.
    detached: !windows,
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`${name} did not start`);
  }
  let gone = false;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      gone = true;
      resolve();
    });
  });
  void exited.then(() => {
    log.end();
  });
  child.stdin.on("error", () => {
    // The replica died with a command in flight: nothing reads it.
  });
  const lines: unknown[] = [];
  const listeners = new Set<(line: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (raw) => {
    log.write(`${raw}\n`);
    const line = parseLine(raw);
    if (line === null) {
      return;
    }
    lines.push(line);
    for (const listener of listeners) {
      listener(line);
    }
  });
  createInterface({ input: child.stderr }).on("line", (raw) => {
    log.write(`${raw}\n`);
  });
  const kill = async (): Promise<void> => {
    if (!gone) {
      // At once, as `kill -9` does: a forwarding batch lasts tens of milliseconds, and spawning
      // `taskkill` takes longer than that. Then the whole tree, in case it started children.
      child.kill("SIGKILL");
      await killTree(pid);
    }
    await exited;
  };
  const replica: Replica = {
    name,
    pid,
    exited,
    alive: () => !gone,
    lines,
    onLine: (listener) => {
      listeners.add(listener);
    },
    send: (command) => {
      if (!gone) {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      }
    },
    kill,
    stop: async (timeoutMs = 20_000) => {
      if (gone) {
        return;
      }
      replica.send({ stop: true });
      const timer = new Promise<"late">((resolve) => {
        setTimeout(() => {
          resolve("late");
        }, timeoutMs).unref();
      });
      if ((await Promise.race([exited.then(() => "done" as const), timer])) === "late") {
        await kill();
      }
    },
  };
  const readyTimeoutMs = spec.readyTimeoutMs ?? 120_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void kill();
      reject(new Error(`${name} wasn't ready in ${String(readyTimeoutMs)} ms (its log: ${spec.logFile})`));
    }, readyTimeoutMs);
    if (lines.some((line) => spec.ready(line))) {
      clearTimeout(timer);
      resolve();
      return;
    }
    replica.onLine((line) => {
      if (spec.ready(line)) {
        clearTimeout(timer);
        resolve();
      }
    });
    void exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`${name} exited before it was ready (its log: ${spec.logFile})`));
    });
  });
  return replica;
};

/** A set of replicas by name: each started, killed and started again under its name. */
export type ReplicaSet = {
  /** Starts (or starts again) the replica of that name. */
  readonly start: (name: string) => Promise<Replica>;
  /** The replica of that name, while it runs. */
  readonly get: (name: string) => Replica | undefined;
  /** The names of the replicas that run. */
  readonly alive: () => readonly string[];
  /** `kill -9` of the named replicas, at once. */
  readonly kill: (names: readonly string[]) => Promise<void>;
  /** Stops every replica gracefully, killing what doesn't stop. */
  readonly stopAll: () => Promise<void>;
  /** Kills every replica. */
  readonly killAll: () => Promise<void>;
};

/** Replicas started from `specOf(name)` each time; a name's log file is its spec's. */
export const replicaSet = (specOf: (name: string) => ReplicaSpec): ReplicaSet => {
  const running = new Map<string, Replica>();
  const set: ReplicaSet = {
    start: async (name) => {
      const before = running.get(name);
      if (before?.alive() === true) {
        throw new Error(`${name} is already running`);
      }
      const replica = await startReplica(name, specOf(name));
      running.set(name, replica);
      void replica.exited.then(() => {
        if (running.get(name) === replica) {
          running.delete(name);
        }
      });
      return replica;
    },
    get: (name) => running.get(name),
    alive: () => [...running.values()].filter((replica) => replica.alive()).map((replica) => replica.name),
    kill: async (names) => {
      await Promise.all(names.flatMap((name) => {
        const replica = running.get(name);
        return replica === undefined ? [] : [replica.kill()];
      }));
    },
    stopAll: async () => {
      await Promise.all([...running.values()].map((replica) => replica.stop()));
    },
    killAll: async () => {
      await Promise.all([...running.values()].map((replica) => replica.kill()));
    },
  };
  return set;
};
