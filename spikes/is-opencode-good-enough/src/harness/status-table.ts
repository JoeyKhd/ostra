// Turns a run's report.json into the markdown tables the README cites.
// `pnpm status [run-folder]` prints them for the newest run, or the one named.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { statusOf, type Criterion } from "./report.ts";
import { SPIKE_ROOT } from "../runner/workspace.ts";

const checkSchema = z.strictObject({ name: z.string(), status: z.enum(["PASS", "FAIL", "SKIPPED"]), note: z.string() });
const criterionSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  checks: z.array(checkSchema),
});

export const ReportSchema = z.strictObject({
  platform: z.string(),
  arch: z.string(),
  node: z.string(),
  opencode: z.string(),
  at: z.string(),
  run: z.string(),
  quick: z.boolean(),
  passBar: z.array(criterionSchema),
  pipeline: criterionSchema,
  dryRunRecords: z.number().int().nonnegative(),
});
export type Report = z.infer<typeof ReportSchema>;

const escapeCell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

const notPassed = (criterion: Criterion): string =>
  criterion.checks
    .filter((c) => c.status !== "PASS")
    .map((c) => `${c.status} ${escapeCell(c.name)}: ${escapeCell(c.note)}`)
    .join("<br>");

const passedCount = (criterion: Criterion): string => `${String(criterion.checks.filter((c) => c.status === "PASS").length)} of ${String(criterion.checks.length)} checks passed`;

const table = (criteria: readonly Criterion[]): string =>
  [
    "| | Status | Bullet | Checks |",
    "|---|---|---|---|",
    ...criteria.map((c) => {
      const status = statusOf(c.checks);
      const open = notPassed(c);
      return `| ${c.id} | ${status === "PASS" ? "PASS" : `**${status}**`} | ${escapeCell(c.title)} | ${passedCount(c)}${open === "" ? "" : `<br>${open}`} |`;
    }),
  ].join("\n");

export type StatusInput = Omit<Report, "passBar" | "pipeline"> & { readonly passBar: readonly Criterion[]; readonly pipeline: Criterion };

export const statusTables = (report: StatusInput): string =>
  [
    `Run \`${report.run}\`${report.quick ? " (--quick)" : ""}: ${report.platform} ${report.arch}, Node ${report.node}, OpenCode ${report.opencode}, ${String(report.dryRunRecords)} dry-run records.`,
    "",
    "**Pass bar**",
    "",
    table(report.passBar),
    "",
    "**Pipeline**",
    "",
    table([report.pipeline]),
    "",
  ].join("\n");

if (import.meta.main) {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const runsDir = path.join(SPIKE_ROOT, ".runs");
  const name = arg ?? (await readdir(runsDir)).filter((n) => n.startsWith("spike-")).sort().at(-1);
  if (name === undefined) {
    console.error("no spike run folder in .runs: run `pnpm spike` first");
    process.exit(2);
  }
  const folder = path.isAbsolute(name) ? name : name.startsWith(".runs") ? path.join(SPIKE_ROOT, name) : path.join(runsDir, name);
  const report = ReportSchema.parse(JSON.parse(await readFile(path.join(folder, "report.json"), "utf8")));
  console.log(statusTables(report));
}
