// Finding the real runs and their ratings on disk, so that one `pnpm spike`
// reports on them as soon as they exist: the sets `pnpm runs --real` made
// (.runs/real-*), and the rating sheets `pnpm sheet` made from them.
//
// What counts as the bar's set of runs is the bar's, not the set's own
// manifest: 10 tickets, three runs each, 30 runs. A set made with
// `--tickets=calc-1 --runs=1` is a trial: it is not complete, and it must
// never read as the bar's runs.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { KeyFileSchema, type KeyFile } from "../rating/schemas.ts";
import { parseRatings, verdictsBySet, type ParsedRatings, type SetVerdict } from "../rating/score.ts";
import { needsRetry } from "../runner/retry.ts";
import { loadRuns, readManifest, type LoadedRun } from "../runner/set-io.ts";
import type { SetManifest } from "../runner/schemas.ts";
import { SPIKE_ROOT } from "../runner/workspace.ts";
import { REQUIRED_RUNS_PER_TICKET, TICKETS } from "../tickets/tickets.ts";

const DEFAULT_RUNS_DIR = path.join(SPIKE_ROOT, ".runs");

/** The runs the pass bar asks for: every ticket, three times. */
export const REQUIRED_RUN_IDS: readonly string[] = TICKETS.flatMap((ticket) => Array.from({ length: REQUIRED_RUNS_PER_TICKET }, (_, i) => `${ticket.id}-r${String(i + 1)}`));

export type RealSet = {
  readonly dir: string;
  /** Relative to the spike, as the sheet's key names it. */
  readonly rel: string;
  readonly manifest: SetManifest;
  readonly runs: readonly LoadedRun[];
  /** What the bar asks for (30), whatever the set was made to hold. */
  readonly expected: number;
  /** How many of the bar's runs are recorded. */
  readonly recorded: number;
  /** Every one of the bar's runs is recorded. */
  readonly complete: boolean;
  /** Recorded runs that are infrastructure failures (an error, a crash, a model error): `--retry-failed` redoes them. */
  readonly needRetry: readonly string[];
};

export const findRealSets = async (runsDir: string = DEFAULT_RUNS_DIR): Promise<RealSet[]> => {
  const names = (await readdir(runsDir).catch((): string[] => [])).filter((name) => name.startsWith("real-")).sort();
  const sets: RealSet[] = [];
  for (const name of names) {
    const dir = path.join(runsDir, name);
    const manifest = await readManifest(dir);
    if (manifest?.mode !== "real") continue;
    const runs = await loadRuns(dir);
    const ids = new Set<string>(runs.map((run) => run.record.runId));
    const recorded = REQUIRED_RUN_IDS.filter((id) => ids.has(id)).length;
    sets.push({
      dir,
      rel: path.relative(SPIKE_ROOT, dir).replaceAll("\\", "/"),
      manifest,
      runs,
      expected: REQUIRED_RUN_IDS.length,
      recorded,
      complete: recorded === REQUIRED_RUN_IDS.length,
      needRetry: runs.filter((run) => needsRetry(run.record)).map((run) => run.record.runId),
    });
  }
  return sets;
};

export type RatedSheet = {
  readonly dir: string;
  readonly key: KeyFile;
  readonly raters: readonly string[];
  readonly verdicts: readonly SetVerdict[];
};

export type SheetSearch = {
  /** The newest sheet that covers exactly the real runs recorded now, scored. Undefined when there is none. */
  readonly sheet: RatedSheet | undefined;
  /** Sheets made from the real sets that were passed over: made before the runs were all there, or before a run was redone. */
  readonly stale: number;
};

/**
 * A sheet is the rating of a set only if it shows those runs: its key lists
 * exactly the runs recorded in each set it names, every one of those sets is
 * complete (30 runs), and no run ended after the sheet was made (a retry
 * replaces a run, and the sheet would show the old one). Anything else is a
 * sheet of some other state of the set, and is not scored as the set.
 */
const coversSets = (key: KeyFile, sets: ReadonlyMap<string, RealSet>): boolean => {
  if (key.entries.length === 0) return false;
  const named = [...new Set(key.entries.map((entry) => entry.setDir))];
  let total = 0;
  for (const rel of named) {
    const set = sets.get(rel);
    if (!set?.complete) return false;
    const inKey = key.entries.filter((entry) => entry.setDir === rel).map((entry) => entry.runId).sort();
    const onDisk = set.runs.map((run) => run.record.runId).sort();
    if (inKey.length !== onDisk.length || inKey.some((id, i) => id !== onDisk[i])) return false;
    if (set.runs.some((run) => run.record.endedAt > key.createdAt)) return false;
    total += set.expected;
  }
  return key.entries.length === total;
};

export const findRealSheet = async (realSets: readonly RealSet[], runsDir: string = DEFAULT_RUNS_DIR): Promise<SheetSearch> => {
  const sets = new Map(realSets.map((set) => [set.rel, set]));
  const names = (await readdir(runsDir).catch((): string[] => [])).filter((name) => name.startsWith("rating-")).sort().reverse();
  let stale = 0;
  for (const name of names) {
    const dir = path.join(runsDir, name);
    let key: KeyFile;
    try {
      key = KeyFileSchema.parse(JSON.parse(await readFile(path.join(dir, "key.json"), "utf8")));
    } catch {
      continue;
    }
    // A sheet of other runs (the dry-run's) is not about the real sets at all.
    if (key.entries.length === 0 || !key.entries.every((entry) => sets.has(entry.setDir))) continue;
    if (!coversSets(key, sets)) {
      stale += 1;
      continue;
    }
    const files = (await readdir(path.join(dir, "ratings")).catch((): string[] => [])).filter((file) => file.toLowerCase().endsWith(".csv")).sort();
    const raters: { rater: string; parsed: ParsedRatings }[] = [];
    for (const file of files) raters.push({ rater: file.replace(/\.csv$/i, ""), parsed: parseRatings(await readFile(path.join(dir, "ratings", file), "utf8")) });
    return { sheet: { dir, key, raters: raters.map((r) => r.rater), verdicts: verdictsBySet(key, raters) }, stale };
  }
  return { sheet: undefined, stale };
};
