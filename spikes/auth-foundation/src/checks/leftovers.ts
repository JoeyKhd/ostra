import fs from "node:fs/promises";
import { clusterOwnerPid, tempDir } from "../db/provision-database.ts";
import { dataDir, spikeRoot } from "../paths.ts";
import { processIsAlive, runProcess } from "../proc.ts";

type ListedProcess = { readonly pid: number; readonly commandLine: string };

/**
 * Every running postgres with its command line. An unreadable listing is an error,
 * never an empty list: a check that cannot look must not report that nothing is there.
 */
const listPostgres = async (): Promise<ListedProcess[]> => {
  const listing =
    process.platform === "win32"
      ? await runProcess(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process -Filter "Name=\'postgres.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }',
          ],
          { cwd: spikeRoot, timeoutMs: 60_000 },
        )
      : await runProcess("ps", ["-eo", "pid=,args="], { cwd: spikeRoot, timeoutMs: 30_000 });
  if (listing.code !== 0 || listing.timedOut) {
    throw new Error(`could not list processes (exit ${String(listing.code)}): ${listing.stderr.slice(-200)}`);
  }
  return listing.stdout.split("\n").flatMap((line): ListedProcess[] => {
    const match = /^\s*(\d+)[|\s]\s*(.*)$/.exec(line.trim());
    const pid = Number.parseInt(match?.[1] ?? "", 10);
    const commandLine = match?.[2] ?? "";
    return Number.isInteger(pid) && commandLine.toLowerCase().includes("postgres") ? [{ pid, commandLine }] : [];
  });
};

const normalised = (value: string): string => value.replaceAll("/", "\\").toLowerCase();

/** A cluster of a run that is still in progress (not this one) is not something this run left behind. */
const belongsToAnotherLiveRun = (clusterName: string): boolean => {
  const owner = clusterOwnerPid(clusterName);
  return owner !== undefined && owner !== process.pid && processIsAlive(owner);
};

const readDirectory = async (directory: string): Promise<string[]> => {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") {
      return [];
    }
    throw error;
  }
};

/**
 * No postgres started by this spike is still running, and no cluster directory or
 * password file is left in `.data`. Another postgres on the machine (the person's own)
 * is not ours: only processes whose command line names this spike's `.data` count. A
 * cluster owned by another run that is still alive (a `pnpm test` beside this run) is
 * left out and counted in the detail.
 */
export const noProcessLeftBehind = async (): Promise<string> => {
  const ours = normalised(dataDir);
  const running = (await listPostgres()).filter((entry) => normalised(entry.commandLine).includes(ours));
  const stillRunning = running.filter((entry) => {
    const named = /pg-\d+-[0-9a-f]+/i.exec(entry.commandLine)?.[0];
    return named === undefined || !belongsToAnotherLiveRun(named);
  });
  if (stillRunning.length > 0) {
    throw new Error(`${String(stillRunning.length)} postgres process(es) of this spike are still running`);
  }

  const clusters = (await readDirectory(dataDir)).filter((entry) => entry.startsWith("pg-"));
  const leftClusters = clusters.filter((entry) => !belongsToAnotherLiveRun(entry));
  if (leftClusters.length > 0) {
    throw new Error(`${String(leftClusters.length)} cluster directory(ies) left in .data`);
  }
  const passwordFiles = (await readDirectory(tempDir)).filter((entry) => entry.startsWith("pg-password-"));
  if (passwordFiles.length > 0) {
    throw new Error(`${String(passwordFiles.length)} throwaway password file(s) left in .data/tmp`);
  }
  const others = clusters.length - leftClusters.length;
  return `no postgres of this spike running, no cluster directory and no password file left in .data${
    others > 0 ? ` (${String(others)} cluster(s) of another run still in progress were not counted)` : ""
  }`;
};
