import { execFile, fork, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { spawnChild } from "@ostra/e2e-m2-failures/procs";
import type { Child } from "@ostra/e2e-m2-failures/procs";
import { waitForHttp } from "@ostra/e2e-m2-failures/stack";

// The demo's own stack (ticket 37, spec section 3's "Before"): the dev database, `replicas` core
// replicas on the ports after the first (as `pnpm dev` with OSTRA_DEV_CORE_REPLICAS starts them,
// without the watch, so a file the run writes never restarts core), and one panel (`next dev`), each
// its own process with its own log. Plus ticket 36's four dev tools, each started as its `pnpm
// dev:*` script runs it, told apart by the ready message it sends over IPC.

export type StackPorts = { readonly web: number; readonly core: number; readonly pg: number };

export type Stack = {
  readonly coreUrls: readonly string[];
  readonly panelUrl: string;
  /** Stops core replica `index` (`kill -9` of its tree) and starts it again on the same port. */
  readonly restartCore: (index: number) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly logFiles: () => readonly string[];
};

const node = process.execPath;

const runToEnd = (script: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(repoRoot, script), ...args], { cwd: repoRoot, env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${String(code)}`));
    });
  });

export const stackEnv = (baseEnv: NodeJS.ProcessEnv, ports: StackPorts): NodeJS.ProcessEnv => ({
  ...baseEnv,
  OSTRA_WEB_PORT: String(ports.web),
  OSTRA_CORE_PORT: String(ports.core),
  OSTRA_DEV_PG_PORT: String(ports.pg),
});

export const startStack = async (input: {
  readonly ports: StackPorts;
  readonly replicas: number;
  readonly baseEnv: NodeJS.ProcessEnv;
  /** What core and the panel get besides the base environment. */
  readonly serverEnv: Readonly<Record<string, string>>;
  readonly logDir: string;
}): Promise<Stack> => {
  const env = { ...stackEnv(input.baseEnv, input.ports), ...input.serverEnv };
  const logFiles: string[] = [];
  const logOf = (name: string): string => {
    const file = path.join(input.logDir, `${name}.log`);
    if (!logFiles.includes(file)) logFiles.push(file);
    return file;
  };
  const db = await spawnChild({ name: "db", command: node, args: [path.join(repoRoot, "packages", "db", "scripts", "dev-postgres.ts")], cwd: repoRoot, env, logFile: logOf("db") });
  await db.waitForLine((line) => line.startsWith("DATABASE_URL="), 120_000);
  await runToEnd("packages/db/scripts/generate.ts", [], env);
  await runToEnd("packages/db/scripts/migrate.ts", [], env);

  const cores: (Child | null)[] = Array.from({ length: input.replicas }, () => null);
  const startCore = async (index: number): Promise<void> => {
    const port = input.ports.core + index;
    const child = await spawnChild({
      name: `core${String(index + 1)}`,
      command: node,
      args: [path.join(repoRoot, "apps", "core", "src", "main.ts")],
      cwd: path.join(repoRoot, "apps", "core"),
      env: { ...env, OSTRA_CORE_PORT: String(port) },
      logFile: logOf(`core${String(index + 1)}`),
    });
    await child.waitForLine((line) => line.startsWith("core is listening on"), 180_000);
    cores[index] = child;
  };
  // The first replica runs the migrations' follow-ups and seeds the first admin; the others after it.
  await startCore(0);
  await Promise.all(cores.slice(1).map((_unused, index) => startCore(index + 1)));

  const webDir = path.join(repoRoot, "apps", "web");
  const web = await spawnChild({
    name: "web",
    command: node,
    args: [path.join(webDir, "node_modules", "next", "dist", "bin", "next"), "dev"],
    cwd: webDir,
    env: { ...env, PORT: String(input.ports.web) },
    logFile: logOf("web"),
  });
  const panelUrl = `http://localhost:${String(input.ports.web)}`;
  await waitForHttp(`${panelUrl}/sign-in`, 300_000);

  return {
    coreUrls: cores.map((_unused, index) => `http://127.0.0.1:${String(input.ports.core + index)}`),
    panelUrl,
    restartCore: async (index) => {
      await cores[index]?.kill9();
      await startCore(index);
    },
    stop: async () => {
      await web.kill9();
      for (const core of cores) await core?.kill9();
      await db.kill9();
    },
    logFiles: () => logFiles,
  };
};

/** One of ticket 36's dev tools, as its `pnpm dev:*` script starts it. */
export type DevTool = {
  /** What it sent when ready: its ports and files, never a credential. */
  readonly ready: Readonly<Record<string, unknown>>;
  /** Its output, in memory only: the registry prints its credentials there, so it's never written to a log. */
  readonly lines: readonly string[];
  readonly stop: () => Promise<void>;
};

export const startDevTool = (script: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<DevTool> =>
  new Promise((resolve, reject) => {
    const child: ChildProcess = fork(path.join(repoRoot, script), [...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const lines: string[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) if (line !== "") lines.push(line);
        if (lines.length > 4000) lines.splice(0, lines.length - 4000);
      });
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} wasn't ready in 120 s`));
    }, 120_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${script} exited with ${String(code)} before it was ready`));
    });
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || Reflect.get(message, "type") !== "ready") return;
      clearTimeout(timer);
      child.removeAllListeners("exit");
      const ready = Object.fromEntries(Object.entries(message));
      resolve({
        ready,
        lines,
        stop: () =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) {
              done();
              return;
            }
            child.once("exit", () => {
              done();
            });
            child.send({ type: "stop" });
            setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
          }),
      });
    });
  });

/** Runs one of a dev tool's switches (`pnpm dev:fake-kube hold 40s`) to its end. */
export const devToolSwitch = (script: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(repoRoot, script), ...args], { cwd: repoRoot, env, windowsHide: true, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error === null) resolve(`${stdout}${stderr}`.trim());
      else reject(new Error(`${script} ${args.join(" ")} failed: ${`${stdout}${stderr}`.trim()}`));
    });
  });
