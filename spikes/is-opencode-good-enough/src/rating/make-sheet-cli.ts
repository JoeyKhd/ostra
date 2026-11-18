// `pnpm sheet --sets=<folder>[,<folder>...] [--out=<folder>] [--seed=<n>]`:
// builds the blind rating sheet from one or more sets of runs. Two sets (two
// models) go on one sheet, shuffled together, so the reviewer can't tell them apart.

import path from "node:path";
import { buildSheet } from "./make-sheet.ts";
import { SPIKE_ROOT } from "../runner/workspace.ts";

const flag = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();

const sets = flag("sets")
  ?.split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
if (sets === undefined || sets.length === 0) {
  console.error("usage: pnpm sheet --sets=<set-folder>[,<set-folder>...] [--out=<folder>] [--seed=<n>]");
  process.exit(2);
}
const seedText = flag("seed");
const seed = seedText === undefined ? undefined : Number(seedText);
if (seed !== undefined && !Number.isInteger(seed)) {
  console.error("--seed must be an integer");
  process.exit(2);
}
const out = path.resolve(SPIKE_ROOT, flag("out") ?? path.join(".runs", `rating-${new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "")}`));

const result = await buildSheet({ setDirs: sets.map((s) => path.resolve(SPIKE_ROOT, s)), outDir: out, ...(seed === undefined ? {} : { seed }) });
console.log(`${String(result.count)} pull requests on the sheet (seed ${String(result.seed)})`);
console.log(`  sheet:    ${result.sheetPath}`);
console.log(`  template: ${result.templatePath}   (fill the rating column; save as ${path.join(out, "ratings", "<name>.csv")})`);
console.log(`  key:      ${result.keyPath}   (do not open it until every rater is done)`);
console.log(`then: pnpm score --sheet=${path.relative(SPIKE_ROOT, out).replaceAll("\\", "/")}`);
