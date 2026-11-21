import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { killTree } from "../cdp/pipe.ts";

// The harness's children: each is started with its output in the run's log folder, and every one is killed
// with its whole tree when the harness ends, however it ends.

export type Child = { readonly name: string; readonly pid: number; readonly process: ChildProcess; readonly ready: Promise<void> };

const children = new Set<Child>();

export const startChild = (name: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; log: string; readyText?: string }): Child => {
  const log: WriteStream = createWriteStream(options.log, { flags: "a" });
  const child = spawn(process.execPath, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (child.pid === undefined) throw new Error(`${name} did not start`);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${name} was not ready in 60 s`));
    }, 60_000);
    const onData = (chunk: Buffer) => {
      log.write(chunk);
      if (options.readyText === undefined || chunk.toString("utf8").includes(options.readyText)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk: Buffer) => log.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      log.write(`[${name} exited ${String(code)}]\n`);
      reject(new Error(`${name} exited (${String(code)})`));
    });
  });
  ready.catch(() => undefined);
  const entry: Child = { name, pid: child.pid, process: child, ready };
  children.add(entry);
  return entry;
};

export const stopChild = async (child: Child) => {
  children.delete(child);
  await killTree(child.pid);
};

export const stopAll = async () => {
  await Promise.all([...children].map((child) => stopChild(child)));
};

let exiting = false;
const onExit = (code: number) => {
  if (exiting) return;
  exiting = true;
  void stopAll().finally(() => process.exit(code));
};
process.on("SIGINT", () => {
  onExit(130);
});
process.on("SIGTERM", () => {
  onExit(143);
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  onExit(1);
});
