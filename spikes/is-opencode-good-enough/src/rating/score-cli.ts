// `pnpm score --sheet=<folder>`: reads the ratings in <folder>/ratings/*.csv,
// unblinds them with <folder>/key.json, and prints the pass bar's verdict next
// to what was recorded per run. Exit 0 PASS, 1 FAIL, 2 SKIPPED (not rated yet).

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { aggregateByTicket, formatRunTable } from "../harness/report-table.ts";
import { loadRuns } from "../runner/set-io.ts";
import type { RunRecord } from "../runner/schemas.ts";
import { SPIKE_ROOT } from "../runner/workspace.ts";
import { KeyFileSchema } from "./schemas.ts";
import { agreement, mergeableShare, parseRatings, scoreRater, verdictsBySet, type ParsedRatings } from "./score.ts";

const sheetArg = process.argv.find((a) => a.startsWith("--sheet="))?.slice("--sheet=".length);
if (sheetArg === undefined) {
  console.error("usage: pnpm score --sheet=<folder made by `pnpm sheet`>");
  process.exit(2);
}
const sheetDir = path.resolve(SPIKE_ROOT, sheetArg);
const key = KeyFileSchema.parse(JSON.parse(await readFile(path.join(sheetDir, "key.json"), "utf8")));

const files = (await readdir(path.join(sheetDir, "ratings")).catch((): string[] => [])).filter((name) => name.toLowerCase().endsWith(".csv")).sort();
const raters: { rater: string; parsed: ParsedRatings }[] = [];
for (const file of files) {
  raters.push({ rater: file.replace(/\.csv$/i, ""), parsed: parseRatings(await readFile(path.join(sheetDir, "ratings", file), "utf8")) });
}
const scores = raters.map((r) => scoreRater(key, r.rater, r.parsed));

for (const score of scores) {
  console.log(`rater ${score.rater}: ${String(score.rated)} of ${String(score.total)} rated`);
  console.log(`  merge-as-is ${String(score.counts["merge-as-is"])}, merge-with-small-edits ${String(score.counts["merge-with-small-edits"])}, reject ${String(score.counts.reject)}; mergeable ${(mergeableShare(score) * 100).toFixed(0)}%`);
  if (score.unknown.length > 0) console.log(`  ${String(score.unknown.length)} rows name an ID that is not on the sheet: ${score.unknown.slice(0, 5).join(", ")}`);
  console.log(`  by ticket: ${score.byTicket.map((t) => `${t.ticketId} ${String(t.mergeable)}/${String(t.runs)}`).join("  ")}`);
}
const agree = agreement(scores);
if (agree !== undefined) {
  console.log(`agreement between ${agree.raters.join(" and ")}: same rating on ${(agree.exact * 100).toFixed(0)}% of runs, same side of the bar on ${(agree.sameSide * 100).toFixed(0)}%`);
}

const verdicts = verdictsBySet(key, raters);
console.log("");
for (const v of verdicts) {
  console.log(`${v.verdict.status.padEnd(7)} ${v.setDir} (${String(v.runs)} runs), rated blind, at least half are "merge as it is" or "merge with small edits": ${v.verdict.note}`);
}

// Unblinded: what each set recorded per run.
const sets = [...new Set(key.entries.map((entry) => entry.setDir))];
const records: RunRecord[] = [];
for (const setDir of sets) records.push(...(await loadRuns(path.resolve(SPIKE_ROOT, setDir))).map((run) => run.record));
if (records.some((r) => r.mode === "dry")) {
  console.log("\nNOTE: some of these runs are dry-runs (a scripted stub model). Rating them tests the tooling and says nothing about OpenCode.");
}
if (records.length > 0) {
  console.log("\nrecorded per run (unblinded)\n");
  console.log(formatRunTable(records));
  const aggregates = aggregateByTicket(records);
  console.log(`\n${String(aggregates.length)} tickets, ${String(records.length)} runs`);
}
const statuses = verdicts.map((v) => v.verdict.status);
process.exitCode = statuses.includes("FAIL") ? 1 : statuses.includes("SKIPPED") ? 2 : 0;
