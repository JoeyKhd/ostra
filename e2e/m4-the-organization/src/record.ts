// `node e2e/m4-the-organization/src/record.ts` (ticket 41): the run's record for demo.md. Every
// `checks-<time>.json` the demo wrote in its state folder, oldest first, merged by the check's name
// (a step run again replaces its earlier result), into the spec's `demo/checks.json`. IDs, words
// and counts only: the checks never hold a secret.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { m4Settings } from "./settings.ts";

const checksSchema = z.array(z.object({ step: z.string(), name: z.string(), ok: z.boolean(), detail: z.string() }));

const settings = m4Settings(process.env);
const files = (await readdir(settings.m4StateDir)).filter((name) => /^checks-\d+\.json$/.test(name)).sort();
const merged = new Map<string, z.infer<typeof checksSchema>[number] & { readonly at: string }>();
for (const file of files) {
  const at = new Date(Number(/\d+/.exec(file)?.[0] ?? "0")).toISOString();
  for (const check of checksSchema.parse(JSON.parse(await readFile(path.join(settings.m4StateDir, file), "utf8")))) {
    merged.set(check.name, { ...check, at });
  }
}
// A step that stopped once and ran to its end later: its stop is history, not the record.
const done = new Set(z.object({ done: z.array(z.string()) }).parse(JSON.parse(await readFile(path.join(settings.m4StateDir, "run.json"), "utf8"))).done);
const record = [...merged.values()].filter((check) => check.ok || !(check.name.endsWith(": the step ran to its end") && done.has(check.step)));
await writeFile(path.join(settings.screenshotDir, "checks.json"), `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${String(record.filter((one) => one.ok).length)} of ${String(record.length)} checks passed, from ${String(files.length)} runs\n`);
