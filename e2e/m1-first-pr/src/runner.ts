import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { repoRoot } from "./settings.ts";
import type { DemoSettings } from "./settings.ts";

// `ostra runner` from source, on the host executor (spec section 1: no Docker on this machine).
// Its output goes to .ostra-dev/e2e-m1/runner.log: the runner logs IDs and fields, never secrets.

export type RunningRunner = {
  /** The device code to approve, or `null` when the runner was already signed in. */
  readonly deviceCode: Promise<string | null>;
  /** Resolves once the runner is signed in and connecting. */
  readonly online: Promise<void>;
  readonly stop: () => Promise<void>;
};

export const startRunner = async (settings: DemoSettings): Promise<RunningRunner> => {
  const folder = path.join(settings.dataDir, "e2e-m1");
  await mkdir(folder, { recursive: true });
  const log = createWriteStream(path.join(folder, "runner.log"), { flags: "a" });
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, "apps", "runner", "src", "main.ts"),
      "runner",
      "--server",
      settings.coreUrl,
      "--data-dir",
      settings.runnerDataDir,
      "--name",
      settings.runnerName,
      "--executor",
      "host",
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let resolveCode: (code: string | null) => void = () => undefined;
  let resolveOnline: () => void = () => undefined;
  let rejectBoth: (error: Error) => void = () => undefined;
  const deviceCode = new Promise<string | null>((resolve, reject) => {
    resolveCode = resolve;
    rejectBoth = reject;
  });
  const online = new Promise<void>((resolve, reject) => {
    resolveOnline = resolve;
    const previous = rejectBoth;
    rejectBoth = (error) => {
      previous(error);
      reject(error);
    };
  });
  // Neither may go unhandled when the runner fails before anyone waits.
  deviceCode.catch(() => undefined);
  online.catch(() => undefined);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      log.write(`${line}\n`);
      const code = /^\s+Code\s+(\S+)\s*$/.exec(line)?.[1];
      if (code !== undefined) resolveCode(code);
      if (line.includes("is connecting to")) {
        resolveCode(null);
        resolveOnline();
      }
      if (!line.startsWith("{")) process.stdout.write(`[runner] ${line}\n`);
    });
  }
  child.on("exit", (code) => {
    rejectBoth(new Error(`the runner exited (code ${String(code)})`));
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.pid === undefined) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      child.kill("SIGINT");
    }
    await exited;
    log.end();
  };
  return { deviceCode, online, stop };
};
