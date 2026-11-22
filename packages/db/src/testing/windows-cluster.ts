import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The test Postgres on Windows, started and stopped with pg_ctl instead of by embedded-postgres.
//
// embedded-postgres stops its server with `taskkill /pid <postmaster> /f /t`, which ends the
// postmaster's children first and the postmaster last. In between, the postmaster takes their
// deaths for a crash: it reinitializes and starts a fresh set (I/O workers, the startup process
// and the rest), which taskkill's list of the tree doesn't hold. One it was starting when taskkill
// reached it is left behind with its postmaster gone, a few MB each, run after run. An agent's
// `taskkill /T /F` of a vitest run does the same, since there the postmaster is the run's child.
//
// pg_ctl stops the server by asking it, a shutdown that starts nothing, and starts it outside the
// run's process tree (pg_ctl's own child, and pg_ctl exits), where a tree kill can't reach it. A
// watchdog, outside the tree too, stops it once the run is gone, however the run ended.

/** pg_ctl.exe, from the same binaries package embedded-postgres runs postgres.exe from. */
export const pgCtlPath = async (): Promise<string> => {
  const embedded = createRequire(import.meta.url).resolve("embedded-postgres");
  const binaries: unknown = await import(
    pathToFileURL(createRequire(embedded).resolve("@embedded-postgres/windows-x64")).href
  );
  const pgCtl: unknown = Reflect.get(Object(binaries), "pg_ctl");
  if (typeof pgCtl !== "string") {
    throw new Error("@embedded-postgres/windows-x64 names no pg_ctl");
  }
  return pgCtl;
};

/**
 * Runs pg_ctl and resolves with its exit code. Its output is ignored: a started server inherits
 * pg_ctl's handles, and a pipe would stay open as long as the server runs.
 */
export const runPgCtl = (pgCtl: string, args: readonly string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(pgCtl, [...args], { stdio: "ignore", windowsHide: true, cwd: tmpdir() });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });

/** The log pg_ctl writes the server's output to, inside the cluster's folder. */
const serverLog = (dir: string): string => path.join(dir, "pg_ctl.log");

/** Starts the cluster in `dir` on `port` and waits until it takes connections. */
export const startCluster = async (
  pgCtl: string,
  dir: string,
  port: number,
  flags: readonly string[],
): Promise<void> => {
  const code = await runPgCtl(pgCtl, [
    "start",
    "-D",
    dir,
    "-l",
    serverLog(dir),
    "-w",
    "-t",
    "180",
    "-o",
    ["-p", String(port), ...flags].join(" "),
  ]);
  if (code !== 0) {
    const log = await readFile(serverLog(dir), "utf8").catch(() => "");
    throw new Error(
      `pg_ctl couldn't start the test Postgres (exit code ${String(code)}). The server's last lines:\n${log.trim().split(/\r?\n/).slice(-10).join("\n")}`,
    );
  }
};

/**
 * Stops the cluster in `dir` and waits until it's gone: a fast shutdown (its connections ended,
 * then a checkpoint), or an immediate one where it's thrown away anyway. Resolves false when no
 * server of that folder was running. pg_ctl signals a postmaster through that postmaster's own
 * pipe, so a stale `postmaster.pid` whose PID another program has since taken is never acted on.
 */
export const stopCluster = async (
  pgCtl: string,
  dir: string,
  mode: "fast" | "immediate",
): Promise<boolean> =>
  (await runPgCtl(pgCtl, ["stop", "-D", dir, "-m", mode, "-w", "-t", "120"])) === 0;

const watchdogScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "cluster-watchdog.ts",
);

/**
 * Starts the cluster's watchdog (`cluster-watchdog.ts`) outside this process's tree: it stops the
 * cluster and removes its folder once this process is gone, and ends on its own once the cluster
 * is stopped.
 */
export const watchCluster = (pgCtl: string, dir: string): void => {
  spawn(process.execPath, [watchdogScript, "--detach", String(process.pid), pgCtl, dir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: tmpdir(),
  }).unref();
};
