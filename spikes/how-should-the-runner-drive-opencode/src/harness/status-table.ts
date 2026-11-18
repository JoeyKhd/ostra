// The README's status tables, generated from a run's report.json, so the
// README never says something a run didn't. `pnpm spike` writes them to the
// run folder as status.md; `pnpm status [run-folder]` prints them for the
// newest run (or the one named).

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { statusOf, type Check } from "./report.ts";

const checkSchema = z.object({ name: z.string(), status: z.enum(["PASS", "FAIL", "SKIPPED"]), note: z.string() });
const criterionSchema = z.object({
  id: z.string(),
  title: z.string(),
  checks: z.array(checkSchema),
  recorded: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
const reportSchema = z.looseObject({
  platform: z.string(),
  arch: z.string(),
  node: z.string(),
  at: z.string(),
  run: z.string().optional(),
  passBar: z.array(criterionSchema),
  results: z.array(criterionSchema),
  leftovers: z.number(),
});

/** A criterion as report.json holds it (`recorded` may be absent). */
type TableCriterion = {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly Check[];
  readonly recorded?: Readonly<Record<string, string | number | boolean | null>> | undefined;
};

export type ReportForTables = {
  readonly platform: string;
  readonly arch: string;
  readonly node: string;
  readonly at: string;
  readonly run?: string;
  readonly passBar: readonly TableCriterion[];
  readonly results: readonly TableCriterion[];
  readonly leftovers: number;
};

const cell = (text: string): string => text.replace(/\s+/g, " ").replaceAll("|", "\\|");

const row = (criterion: TableCriterion): string => {
  const status = statusOf(criterion.checks);
  const notable = criterion.checks.filter((c) => c.status !== "PASS");
  const detail =
    notable.length === 0
      ? `${String(criterion.checks.length)} checks passed`
      : notable.map((c) => `${c.status} ${c.name}: ${c.note}`).join("<br>");
  return `| ${criterion.id} | ${status === "PASS" ? "PASS" : `**${status}**`} | ${cell(criterion.title)} | ${cell(detail)} |`;
};

export const statusTables = (report: ReportForTables): string => {
  const lines: string[] = [];
  lines.push(`Generated from \`${report.run ?? "report.json"}/report.json\` (${report.platform} ${report.arch}, Node ${report.node}, ${report.at}). Final sweep: ${String(report.leftovers)} leftover processes.`, "");
  lines.push("**Pass bar**", "", "| | Status | Bullet | Checks not passed |", "|---|---|---|---|");
  for (const criterion of report.passBar) lines.push(row(criterion));
  lines.push("", "**Cases**", "", "| | Status | Case | Checks not passed |", "|---|---|---|---|");
  for (const criterion of report.results) if (!criterion.id.startsWith("B")) lines.push(row(criterion));
  lines.push("", "**Every check**", "");
  for (const criterion of [...report.passBar.filter((c) => c.id === "B3" || c.id === "B4"), ...report.results.filter((c) => !c.id.startsWith("B"))]) {
    lines.push(`- **${criterion.id}**`);
    for (const c of criterion.checks) lines.push(`  - ${c.status} ${cell(c.name)}: ${cell(c.note)}`);
    for (const [key, value] of Object.entries(criterion.recorded ?? {})) lines.push(`  - recorded ${cell(key)} = ${cell(String(value))}`);
  }
  return `${lines.join("\n")}\n`;
};

const main = async (): Promise<void> => {
  const runsDir = path.resolve(import.meta.dirname, "..", "..", ".runs");
  const named = process.argv[2];
  const folder = named ?? (await readdir(runsDir)).filter((name) => name.startsWith("run-")).sort().reverse()[0];
  if (folder === undefined) throw new Error("no run folder in .runs/");
  const raw: unknown = JSON.parse(await readFile(path.join(runsDir, path.basename(folder), "report.json"), "utf8"));
  const parsed = reportSchema.parse(raw);
  process.stdout.write(statusTables({ ...parsed, run: parsed.run ?? path.basename(folder) }));
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
