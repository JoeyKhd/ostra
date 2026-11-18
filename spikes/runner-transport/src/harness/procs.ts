import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import { parseJson } from "../protocol/messages.ts";
import { sleep } from "../shared/stats.ts";

// Child processes for the harness: replicas, runners, load generators.
// Every child is registered, and `killAll` kills whole process trees
// (taskkill /T /F on Windows), so nothing outlives a run.

export type JsonLine = Readonly<Record<string, unknown>>;
const LineSchema = z.record(z.string(), z.unknown());

export type Child = {
  readonly name: string;
  readonly pid: number;
  readonly lines: JsonLine[];
  readonly exited: Promise<number | null>;
  readonly isAlive: () => boolean;
  readonly send: (obj: unknown) => void;
  readonly waitFor: (pred: (l: JsonLine) => boolean, timeoutMs: number, fromIndex?: number) => Promise<JsonLine | undefined>;
  readonly kill9: () => Promise<void>;
};

const children = new Set<ChildProcess>();

export const killTree = async (pid: number): Promise<void> => {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
        resolve();
      });
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

export const killAll = async (): Promise<void> => {
  const pids = [...children].map((c) => c.pid).filter((p): p is number => p !== undefined);
  await Promise.all(pids.map(killTree));
  children.clear();
};

/**
 * Spawn any process the harness owns: registered, so `killAll` and the SIGINT
 * handler reach it, and its own process group off Windows, so `killTree` can
 * signal the whole group.
 */
export const spawnProcess = (
  bin: string,
  args: readonly string[],
  o: { readonly env?: NodeJS.ProcessEnv; readonly stdio: "pipe" | "ignore" },
): ChildProcess => {
  const proc = spawn(bin, [...args], {
    ...(o.env === undefined ? {} : { env: o.env }),
    stdio: o.stdio,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  children.add(proc);
  proc.on("exit", () => {
    children.delete(proc);
  });
  return proc;
};

let logDir = ".";
export const setLogDir = (dir: string): void => {
  logDir = dir;
};

export const spawnNode = (
  name: string,
  script: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Child => {
  const proc = spawnProcess(process.execPath, ["--no-warnings", script, ...args, `--parent-pid=${String(process.pid)}`], { env, stdio: "pipe" });
  const { stdin, stdout, stderr } = proc;
  if (stdin === null || stdout === null || stderr === null) throw new Error(`${name}: no stdio pipes`);
  const pid = proc.pid ?? -1;
  const lines: JsonLine[] = [];
  const listeners = new Set<() => void>();
  const out: WriteStream = createWriteStream(path.join(logDir, `${name}.log`), { flags: "a" });
  let alive = true;
  const exited = new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => {
      alive = false;
      for (const l of listeners) l();
      resolve(code);
    });
  });
  readline.createInterface({ input: stdout }).on("line", (line) => {
    out.write(`${line}\n`);
    const parsed = parseJson(line);
    const rec = parsed.ok ? LineSchema.safeParse(parsed.value) : undefined;
    if (rec?.success === true) {
      lines.push(rec.data);
      for (const l of listeners) l();
    }
  });
  readline.createInterface({ input: stderr }).on("line", (line) => {
    out.write(`[stderr] ${line}\n`);
  });
  stdin.on("error", () => undefined);

  return {
    name,
    pid,
    lines,
    exited,
    isAlive: () => alive,
    send: (obj) => {
      if (alive) stdin.write(`${JSON.stringify(obj)}\n`);
    },
    waitFor: (pred, timeoutMs, fromIndex = 0) =>
      new Promise((resolve) => {
        let i = fromIndex;
        const check = (): boolean => {
          for (; i < lines.length; i += 1) {
            const l = lines[i];
            if (l !== undefined && pred(l)) {
              done(l);
              return true;
            }
          }
          if (!alive) {
            done(undefined);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          done(undefined);
        }, timeoutMs);
        const listener = (): void => {
          check();
        };
        const done = (l: JsonLine | undefined): void => {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(l);
        };
        if (!check()) listeners.add(listener);
      }),
    kill9: async () => {
      await killTree(pid);
      await Promise.race([exited, sleep(5_000)]);
    },
  };
};

export const str = (l: JsonLine | undefined, key: string): string | undefined => {
  const v = l?.[key];
  return typeof v === "string" ? v : undefined;
};
export const num = (l: JsonLine | undefined, key: string): number | undefined => {
  const v = l?.[key];
  return typeof v === "number" ? v : undefined;
};
