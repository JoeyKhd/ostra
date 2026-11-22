import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { generatorLineSchema } from "./generator-protocol.ts";
import type { GeneratorArgs, GeneratorCommand, GeneratorLine } from "./generator-protocol.ts";

// The harness's side of its generator processes (ticket 34): it starts each with its share of
// runners, sends commands, and waits for the lines it needs. A child's stderr goes to its log.

export type GeneratorProcess = {
  readonly index: number;
  /** The child's process ID: each generator is a process of its own. */
  readonly pid: number;
  readonly send: (command: GeneratorCommand) => void;
  /** Resolves with the next line of type `t` from now on. */
  readonly next: <T extends GeneratorLine["t"]>(t: T, timeoutMs: number) => Promise<Extract<GeneratorLine, { t: T }>>;
  readonly onLine: (listener: (line: GeneratorLine) => void) => void;
  readonly stop: () => Promise<void>;
};

/**
 * How many simulated runners each generator process joins (ticket 34): one process per `perProcess`
 * tasks, so no single event loop is the limit, and the runners split as evenly as they go.
 */
export const generatorShares = (tasks: number, slots: number, perProcess: number): readonly number[] => {
  const runnerCount = Math.ceil(tasks / slots);
  const generatorCount = Math.ceil(tasks / perProcess);
  const perGenerator = Math.ceil(runnerCount / generatorCount);
  const shares: number[] = [];
  for (let index = 0; index < generatorCount; index += 1) {
    const runners = Math.min(perGenerator, runnerCount - index * perGenerator);
    if (runners <= 0) break;
    shares.push(runners);
  }
  return shares;
};

const isLine = <T extends GeneratorLine["t"]>(line: GeneratorLine, t: T): line is Extract<GeneratorLine, { t: T }> => line.t === t;

export const startGenerator = (index: number, args: GeneratorArgs, logDir: string): GeneratorProcess => {
  // The join token goes in the child's environment, not its command line, which other processes can read.
  const { joinToken, ...rest } = args;
  const child: ChildProcess = spawn(process.execPath, [path.join(import.meta.dirname, "generator.ts"), JSON.stringify(rest)], {
    env: { ...process.env, OSTRA_LOAD_JOIN_TOKEN: joinToken },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = createWriteStream(path.join(logDir, `generator-${String(index + 1)}.log`));
  child.stderr?.pipe(log);
  const listeners: ((line: GeneratorLine) => void)[] = [];
  if (child.stdout !== null) {
    readline.createInterface({ input: child.stdout }).on("line", (text) => {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        log.write(`${text}\n`);
        return;
      }
      const parsed = generatorLineSchema.safeParse(raw);
      if (!parsed.success) {
        log.write(`${text}\n`);
        return;
      }
      if (parsed.data.t === "error") log.write(`error: ${parsed.data.message}\n`);
      for (const listener of [...listeners]) listener(parsed.data);
    });
  }
  return {
    index,
    pid: child.pid ?? 0,
    send: (command) => {
      child.stdin?.write(`${JSON.stringify(command)}\n`);
    },
    next: <T extends GeneratorLine["t"]>(t: T, timeoutMs: number) =>
      new Promise<Extract<GeneratorLine, { t: T }>>((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new Error(`generator ${String(index + 1)} sent no ${t} in ${String(Math.round(timeoutMs / 1000))} s`));
        }, timeoutMs);
        const exited = (): void => {
          remove();
          reject(new Error(`generator ${String(index + 1)} exited`));
        };
        const listener = (line: GeneratorLine): void => {
          if (!isLine(line, t)) return;
          remove();
          resolve(line);
        };
        const remove = (): void => {
          clearTimeout(timer);
          child.off("exit", exited);
          const at = listeners.indexOf(listener);
          if (at !== -1) listeners.splice(at, 1);
        };
        child.once("exit", exited);
        listeners.push(listener);
      }),
    onLine: (listener) => {
      listeners.push(listener);
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin?.end();
      }),
  };
};
