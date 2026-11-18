// The blind rating sheet. Every run's diff goes on it under a random ID, in a
// random order, with the ticket, the CI result a reviewer would see, and the
// agent's own pull request description. It says nothing about which run, which
// model, how long, how much or how many turns: those would colour the rating.
// The key that turns an ID back into a run goes in a separate file.
//
// The agent's output is untrusted text: it goes into fenced blocks only, with a
// fence longer than anything inside, so it can't alter the sheet.

import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ticketKey } from "../tickets/schema.ts";
import { ticketById } from "../tickets/tickets.ts";
import type { RunRecord } from "../runner/schemas.ts";
import { loadRuns } from "../runner/set-io.ts";
import { SPIKE_ROOT } from "../runner/workspace.ts";
import { csvLine } from "./csv.ts";
import { BlindIdSchema, RATINGS, RATINGS_HEADER, type BlindId, type KeyFile } from "./schemas.ts";

/** A small seeded generator (mulberry32), so a sheet can be rebuilt with the same IDs and order. */
export const seededRandom = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Fisher-Yates, on a copy. */
export const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
};

const blindIdFrom = (random: () => number): BlindId => BlindIdSchema.parse(`R-${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`);

/** A code fence longer than any run of backticks inside the text. */
export const fenced = (text: string, language: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}`;
};

const quoted = (text: string): string =>
  text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

const MAX_DIFF_LINES = 700;
const MAX_SUMMARY_CHARS = 3000;

const ciLine = (record: RunRecord): string => {
  const { ci } = record.checks;
  const tests = ci.tests.ran ? `${String(ci.tests.pass)} of ${String(ci.tests.total)} tests pass` : "no tests ran";
  const types = ci.typecheck.ok ? "the strict typecheck is clean" : `the strict typecheck reports ${String(ci.typecheck.errors)} errors`;
  return ci.green ? `green: ${tests}, ${types}` : `RED: ${tests}, ${types}`;
};

const changedLine = (record: RunRecord): string => {
  const { files, insertions, deletions } = record.diff;
  if (files.length === 0) return "no files changed";
  return `${String(files.length)} file${files.length === 1 ? "" : "s"}, +${String(insertions)} -${String(deletions)}: ${files.map((file) => file.path).join(", ")}`;
};

export const SHEET_INSTRUCTIONS = `Each entry below is a pull request: the diff an agent left for the ticket shown, the CI result a reviewer would see on it, and the agent's own description. They are in random order, and nothing here says which run or model produced which.

Rate each one as a reviewer who owns this repository would. In \`ratings-template.csv\` put one of these in the \`rating\` column (save your copy as \`ratings/<your-name>.csv\`):

- \`merge-as-is\`: you would merge it now.
- \`merge-with-small-edits\`: you would merge it after a few small edits (a name, a comment, a missing edge case) without sending it back.
- \`reject\`: you would send it back, or rewrite it.

Judge it against its ticket: does it do what was asked and nothing else that matters, is it correct, is it the size and shape you would accept, and does it carry a test where the repository's conventions ask for one (its README lists them). A diff with no changes is a \`reject\`.

Do not open \`key.json\`. It says which run each ID is, and rating blind is the point.`;

export type SheetOptions = {
  /** Folders of runs (a set each), as made by \`pnpm runs\`. */
  readonly setDirs: readonly string[];
  readonly outDir: string;
  /** The same seed on the same runs gives the same IDs and order. Default: random. */
  readonly seed?: number;
  /** For tests: the clock. */
  readonly now?: Date;
};

export type SheetResult = {
  readonly count: number;
  readonly seed: number;
  readonly sheetPath: string;
  readonly templatePath: string;
  readonly keyPath: string;
  readonly text: string;
  readonly key: KeyFile;
};

type Item = { readonly record: RunRecord; readonly dir: string; readonly setDir: string };

export const buildSheet = async (options: SheetOptions): Promise<SheetResult> => {
  const items: Item[] = [];
  for (const setDir of options.setDirs) {
    for (const run of await loadRuns(setDir)) items.push({ record: run.record, dir: run.dir, setDir });
  }
  if (items.length === 0) throw new Error("no runs with a record in the given set folders");

  const seed = options.seed ?? randomInt(1, 2 ** 31 - 1);
  const random = seededRandom(seed);
  const used = new Set<string>();
  const ids = new Map<Item, BlindId>();
  for (const item of items) {
    let id = blindIdFrom(random);
    while (used.has(id)) id = blindIdFrom(random);
    used.add(id);
    ids.set(item, id);
  }
  const ordered = shuffled(items, random);

  await mkdir(path.join(options.outDir, "patches"), { recursive: true });
  await mkdir(path.join(options.outDir, "ratings"), { recursive: true });

  const allDry = items.every((item) => item.record.mode === "dry");
  const sections: string[] = [];
  for (const item of ordered) {
    const id = ids.get(item);
    const ticket = ticketById(item.record.ticketId);
    if (id === undefined || ticket === undefined) throw new Error(`run ${item.record.runId} names a ticket this harness doesn't know`);
    const patch = await readFile(path.join(item.dir, "diff.patch"), "utf8").catch(() => "");
    const summary = (await readFile(path.join(item.dir, "summary.txt"), "utf8").catch(() => "")).trim();
    await writeFile(path.join(options.outDir, "patches", `${id}.patch`), patch);

    const patchLines = patch.split("\n");
    const shownPatch = patchLines.length > MAX_DIFF_LINES ? `${patchLines.slice(0, MAX_DIFF_LINES).join("\n")}\n... (${String(patchLines.length - MAX_DIFF_LINES)} more lines: see patches/${id}.patch)` : patch;
    const shownSummary = summary === "" ? "(the agent left no description)" : summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}... (cut)` : summary;
    sections.push(
      [
        `## ${id}`,
        "",
        `**${ticketKey(ticket.id)} (${ticket.kind}): ${ticket.title}**`,
        "",
        quoted(ticket.body),
        "",
        `- **CI:** ${ciLine(item.record)}`,
        `- **Changed:** ${changedLine(item.record)}`,
        "",
        "**Pull request description, from the agent**",
        "",
        fenced(shownSummary, "text"),
        "",
        "**Diff**",
        "",
        patch.trim() === "" ? "(no changes)" : fenced(shownPatch, "diff"),
        "",
        `Rating for ${id}: ${RATINGS.join(" | ")}`,
        "",
      ].join("\n"),
    );
  }

  const text = [
    "# Blind rating sheet",
    "",
    ...(allDry ? ["> This sheet was made from a dry-run: the diffs come from a scripted stub model. It tests the tooling and is not to be rated.", ""] : []),
    `${String(items.length)} pull requests.`,
    "",
    SHEET_INSTRUCTIONS,
    "",
    "---",
    "",
    sections.join("\n---\n\n"),
  ].join("\n");

  const sheetPath = path.join(options.outDir, "sheet.md");
  const templatePath = path.join(options.outDir, "ratings-template.csv");
  const keyPath = path.join(options.outDir, "key.json");
  const key: KeyFile = {
    schema: 1,
    seed,
    createdAt: (options.now ?? new Date()).toISOString(),
    entries: ordered.flatMap((item) => {
      const id = ids.get(item);
      return id === undefined ? [] : [{ id, runId: item.record.runId, ticketId: item.record.ticketId, setDir: path.relative(SPIKE_ROOT, path.resolve(item.setDir)).replaceAll("\\", "/") }];
    }),
  };
  await writeFile(sheetPath, text);
  await writeFile(templatePath, `${[csvLine(RATINGS_HEADER), ...key.entries.map((entry) => csvLine([entry.id, "", ""]))].join("\n")}\n`);
  await writeFile(keyPath, JSON.stringify(key, null, 2));
  return { count: items.length, seed, sheetPath, templatePath, keyPath, text, key };
};
