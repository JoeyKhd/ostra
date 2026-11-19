import { spawn } from "node:child_process";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { z } from "zod";

import { spawnChild } from "../tools/procs.ts";
import type { Child } from "../tools/procs.ts";

// The suite's own stack (ticket 38): an empty dev database, core and the panel, each its own
// process so a case can `kill -9` it and start it again. Core runs as `apps/core/src/testing/
// restart-child.ts`, which is core's own `startCore` with the settings main.ts reads, plus the test
// knobs a case may set: a kill point, the fault proxy in front of Linear, and the runaway timers in
// seconds. The panel is `next dev`, as `pnpm dev` runs it.

export type StackPorts = { readonly web: number; readonly core: number; readonly pg: number };

export type StackInput = {
  readonly ports: StackPorts;
  /** The environment every piece starts from: the suite's own variables already left out. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** What core gets besides it (the fault proxies, the public address, the timers). */
  readonly coreEnv: Readonly<Record<string, string>>;
  /** What the panel gets besides it. */
  readonly webEnv: Readonly<Record<string, string>>;
  readonly logDir: string;
};

export type Stack = {
  readonly panelUrl: string;
  readonly coreUrl: string;
  readonly core: () => Child;
  readonly web: () => Child;
  /** `kill -9` of core, then a fresh start, with `extraEnv` on top of its settings for this start only. */
  readonly restartCore: (extraEnv?: Readonly<Record<string, string>>) => Promise<void>;
  readonly killCore: () => Promise<void>;
  readonly startCore: (extraEnv?: Readonly<Record<string, string>>) => Promise<void>;
  readonly killWeb: () => Promise<void>;
  readonly startWeb: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /** The stack's log files, searched for credentials after the run. */
  readonly logFiles: () => readonly string[];
};

const node = process.execPath;

/** Runs a script of the repo to its end; throws when it fails. */
const runToEnd = (script: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(repoRoot, script), ...args], { cwd: repoRoot, env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${String(code)}`));
    });
  });

const listeningSchema = z.object({ listening: z.number().int().positive() });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `url` until it answers at all (any status), or throws after `timeoutMs`. */
export const waitForHttp = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(10_000) });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`${url} did not answer in ${String(timeoutMs)} ms`);
      await sleep(1000);
    }
  }
};

const stackEnv = (baseEnv: NodeJS.ProcessEnv, ports: StackPorts): NodeJS.ProcessEnv => ({
  ...baseEnv,
  OSTRA_WEB_PORT: String(ports.web),
  OSTRA_CORE_PORT: String(ports.core),
  OSTRA_DEV_PG_PORT: String(ports.pg),
});

/** `pnpm dev:reset --yes`: an empty data folder, the database, the server's keys, everything. Run first. */
export const resetDevData = async (baseEnv: NodeJS.ProcessEnv, ports: StackPorts): Promise<void> => {
  await runToEnd("packages/db/scripts/reset.ts", ["--yes"], stackEnv(baseEnv, ports));
};

export const startStack = async (input: StackInput): Promise<Stack> => {
  const { ports, baseEnv, logDir } = input;
  const env = stackEnv(baseEnv, ports);
  const logFiles: string[] = [];
  const logOf = (name: string): string => {
    const file = path.join(logDir, `${name}.log`);
    if (!logFiles.includes(file)) logFiles.push(file);
    return file;
  };

  const db = await spawnChild({ name: "db", command: node, args: [path.join(repoRoot, "packages", "db", "scripts", "dev-postgres.ts")], cwd: repoRoot, env, logFile: logOf("db") });
  await db.waitForLine((line) => line.startsWith("DATABASE_URL="), 120_000);
  await runToEnd("packages/db/scripts/generate.ts", [], env);
  await runToEnd("packages/db/scripts/migrate.ts", [], env);

  let core: Child | null = null;
  let web: Child | null = null;

  const startCore = async (extraEnv: Readonly<Record<string, string>> = {}): Promise<void> => {
    const child = await spawnChild({
      name: "core",
      command: node,
      args: [path.join(repoRoot, "apps", "core", "src", "testing", "restart-child.ts")],
      cwd: repoRoot,
      env: { ...env, ...input.coreEnv, ...extraEnv },
      logFile: logOf("core"),
    });
    await child.waitForLine((line) => listeningSchema.safeParse(((): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })()).success, 120_000);
    core = child;
  };
  const killCore = async (): Promise<void> => {
    await core?.kill9();
    core = null;
  };
  const startWeb = async (): Promise<void> => {
    const webDir = path.join(repoRoot, "apps", "web");
    web = await spawnChild({
      name: "web",
      command: node,
      args: [path.join(webDir, "node_modules", "next", "dist", "bin", "next"), "dev"],
      cwd: webDir,
      env: { ...env, ...input.webEnv, PORT: String(ports.web) },
      logFile: logOf("web"),
    });
    await waitForHttp(`http://localhost:${String(ports.web)}/sign-in`, 240_000);
  };
  const killWeb = async (): Promise<void> => {
    await web?.kill9();
    web = null;
  };

  await startCore();
  await startWeb();

  return {
    panelUrl: `http://localhost:${String(ports.web)}`,
    coreUrl: `http://127.0.0.1:${String(ports.core)}`,
    core: () => {
      if (core === null) throw new Error("core isn't running");
      return core;
    },
    web: () => {
      if (web === null) throw new Error("the panel isn't running");
      return web;
    },
    restartCore: async (extraEnv = {}) => {
      await killCore();
      await startCore(extraEnv);
    },
    killCore,
    startCore,
    killWeb,
    startWeb,
    stop: async () => {
      await killWeb();
      await killCore();
      await db.kill9();
    },
    logFiles: () => logFiles,
  };
};
