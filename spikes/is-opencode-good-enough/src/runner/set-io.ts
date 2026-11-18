// Reading a set of runs back from disk: the manifest and every run's record,
// validated, because everything downstream (the report, the blind sheet, the
// score) works from these files and trusts the types after this point.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RunRecordSchema, SetManifestSchema, type RunRecord, type SetManifest } from "./schemas.ts";

export const runsDirOf = (setDir: string): string => path.join(setDir, "runs");

export const readManifest = async (setDir: string): Promise<SetManifest | undefined> => {
  try {
    return SetManifestSchema.parse(JSON.parse(await readFile(path.join(setDir, "set.json"), "utf8")));
  } catch {
    return undefined;
  }
};

export const readRecord = async (runDir: string): Promise<RunRecord | undefined> => {
  try {
    return RunRecordSchema.parse(JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")));
  } catch {
    return undefined;
  }
};

export type LoadedRun = { readonly record: RunRecord; readonly dir: string };

/** Every run in a set that has a valid record, ordered by ticket and then by index. */
export const loadRuns = async (setDir: string): Promise<LoadedRun[]> => {
  const runsDir = runsDirOf(setDir);
  const names = await readdir(runsDir).catch((): string[] => []);
  const loaded: LoadedRun[] = [];
  for (const name of names) {
    const dir = path.join(runsDir, name);
    const record = await readRecord(dir);
    if (record !== undefined) loaded.push({ record, dir });
  }
  const ticketNumber = (id: string): number => Number(id.replace(/^\D+/, ""));
  return loaded.sort((a, b) => ticketNumber(a.record.ticketId) - ticketNumber(b.record.ticketId) || a.record.index - b.record.index);
};
