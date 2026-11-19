// `ostra runner` from source for the setup spec (ticket 37), on the host executor: a personal
// runner signing in with a device code. Adapted from e2e/m1-first-pr/src/runner.ts, minus the
// demo's log files. It runs with a minimal environment and its own data folder.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { e2eCoreUrl, e2eRunnerName } from "./settings.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

export type E2eRunner = {
  /** The device code the runner printed, to approve in the panel. */
  readonly deviceCode: Promise<string>;
  /** Resolves once the runner is signed in and connecting to core. */
  readonly signedIn: Promise<void>;
  readonly stop: () => Promise<void>;
};

export const startRunner = async (): Promise<E2eRunner> => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ostra-web-e2e-runner-"));
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, "apps", "runner", "src", "main.ts"), "runner", "--server", e2eCoreUrl, "--data-dir", dataDir, "--name", e2eRunnerName, "--executor", "host"],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        PATH: process.env["PATH"] ?? "",
        SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
        HOME: dataDir,
        USERPROFILE: dataDir,
        TEMP: dataDir,
        TMP: dataDir,
      },
    },
  );
  let resolveCode: (code: string) => void = () => undefined;
  let resolveSignedIn: () => void = () => undefined;
  let rejectBoth: (error: Error) => void = () => undefined;
  const deviceCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectBoth = reject;
  });
  const signedIn = new Promise<void>((resolve, reject) => {
    resolveSignedIn = resolve;
    const previous = rejectBoth;
    rejectBoth = (error) => {
      previous(error);
      reject(error);
    };
  });
  // Neither may go unhandled when the runner fails before anyone waits.
  deviceCode.catch(() => undefined);
  signedIn.catch(() => undefined);
  const tail: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      tail.push(line);
      if (tail.length > 40) tail.shift();
      const code = /^\s+Code\s+(\S+)\s*$/.exec(line)?.[1];
      if (code !== undefined) resolveCode(code);
      if (line.includes("is connecting to")) resolveSignedIn();
    });
  }
  child.on("exit", (code) => {
    rejectBoth(new Error(`the runner exited (code ${String(code)}):\n${tail.join("\n")}`));
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.pid !== undefined) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        child.kill("SIGINT");
      }
      await exited;
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };
  return { deviceCode, signedIn, stop };
};
