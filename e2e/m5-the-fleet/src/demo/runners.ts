import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "@ostra/e2e-m1/settings";
import { say } from "@ostra/e2e-m1/setup";
import { spawnChild } from "@ostra/e2e-m2-failures/procs";
import type { Child } from "@ostra/e2e-m2-failures/procs";

// The demo's runners (ticket 37, spec section 3's "Before"): the CLI packed from this checkout
// (`pnpm --filter @ostra/runner pack:cli`) and installed by npm from its tarball into a folder of its
// own, so every runner is the npm CLI a person would run. A pool runner gets its join token in
// `OSTRA_JOIN_TOKEN`, never on its command line; its output goes to its own log, which the checks
// after the run search for every credential by value.

const run = (command: string, args: readonly string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout);
      else reject(new Error(`${path.basename(command)} ${args.slice(0, 2).join(" ")} failed: ${stderr.slice(0, 1500)}`));
    });
  });

/** npm's own CLI, run by this Node with no shell. */
const npm = (args: readonly string[], cwd: string): Promise<string> =>
  run(process.execPath, [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args], cwd);

export type InstalledCli = { readonly tarball: string; readonly entry: string; readonly version: string };

/**
 * Packs the CLI and installs it from the tarball into `dir`. `withAgent`: also installs OpenCode
 * beside it (the `host` executor runs the agent from `@opencode/cli`), which the tarball doesn't carry.
 */
export const installCli = async (dir: string, withAgent: boolean): Promise<InstalledCli> => {
  const tarball = (await run(process.execPath, [path.join(repoRoot, "apps", "runner", "src", "pack", "pack-cli.ts")], repoRoot)).trim().split(/\r?\n/).at(-1) ?? "";
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ private: true })}\n`);
  await npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball, ...(withAgent ? ["@opencode/cli@2.3.2"] : [])], dir);
  const entry = path.join(dir, "node_modules", "ostra", "dist", "ostra.js");
  const version = (await run(process.execPath, [entry, "--version"], dir)).trim();
  say(`the CLI ${version}, packed to ${path.basename(tarball)} and installed from it`);
  return { tarball, entry, version };
};

export type RunnerProcess = {
  readonly name: string;
  readonly dataDir: string;
  readonly logFile: string;
  readonly child: Child;
  /** Resolves once the runner says it's connecting; rejects if it exits first. */
  readonly connecting: Promise<void>;
  readonly stop: () => Promise<void>;
};

export type RunnerInput = {
  readonly cli: InstalledCli;
  readonly name: string;
  readonly dataDir: string;
  readonly logDir: string;
  readonly serverUrl: string;
  readonly executor: "host" | "kubernetes";
  readonly joinToken?: string;
  readonly labels?: readonly string[];
  readonly slots?: number;
  /** What the runner's environment gets besides the base one: a proxy, a CA, a kubeconfig. */
  readonly env?: Readonly<Record<string, string>>;
  readonly transport?: "auto" | "websocket" | "http";
};

/** The environment a runner starts with: this process's, without the demo's own variables or the server's. */
const runnerBaseEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OSTRA_") && !["DATABASE_URL", "LINEAR_API_KEY", "GITHUB_TEST_TOKEN", "GITHUB_TEST_ADMIN_TOKEN"].includes(name)));

export const startPoolRunner = async (input: RunnerInput): Promise<RunnerProcess> => {
  await mkdir(input.dataDir, { recursive: true });
  const logFile = path.join(input.logDir, `runner-${input.name}.log`);
  const args = [
    input.cli.entry,
    "runner",
    "--server",
    input.serverUrl,
    "--data-dir",
    input.dataDir,
    "--name",
    input.name,
    "--executor",
    input.executor,
    ...(input.labels === undefined || input.labels.length === 0 ? [] : ["--labels", input.labels.join(",")]),
    ...(input.slots === undefined ? [] : ["--slots", String(input.slots)]),
    ...(input.transport === undefined ? [] : ["--transport", input.transport]),
  ];
  const child = await spawnChild({
    name: input.name,
    command: process.execPath,
    args,
    cwd: input.dataDir,
    env: {
      ...runnerBaseEnv(),
      // The development switch for a `host` pool on this machine (spec section 1, "On this machine").
      OSTRA_DEV_HOST_POOL_SAME_USER: "true",
      OSTRA_RUNNER_WS_RETRY_MINUTES: "1",
      ...(input.joinToken === undefined ? {} : { OSTRA_JOIN_TOKEN: input.joinToken }),
      ...input.env,
    },
    logFile,
  });
  const connecting = child.waitForLine((line) => line.includes("is connecting to"), 120_000).then(() => undefined);
  connecting.catch(() => undefined);
  return { name: input.name, dataDir: input.dataDir, logFile, child, connecting, stop: () => child.kill9() };
};

/** A runner that should be refused: its exit code and its last lines, once it exits (or `null` if it didn't in time). */
export const refusedRunner = async (input: RunnerInput, timeoutMs = 60_000): Promise<{ readonly code: number | null; readonly output: string } | null> => {
  const runner = await startPoolRunner(input);
  const exited = await Promise.race([runner.child.exited.then((code) => ({ code })), new Promise<null>((resolve) => setTimeout(() => { resolve(null); }, timeoutMs))]);
  if (exited === null) {
    await runner.stop();
    return null;
  }
  return { code: exited.code, output: runner.child.lines.filter((line) => !line.startsWith("{")).join("\n") };
};
