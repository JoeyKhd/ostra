// `pnpm report <set-folder>`: what was recorded per run in a set (spend from
// the proxy, time, turns, approvals, events), and the checks beside it.

import path from "node:path";
import { formatRunTable } from "./report-table.ts";
import { loadRuns, readManifest } from "../runner/set-io.ts";
import { SPIKE_ROOT } from "../runner/workspace.ts";

const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (arg === undefined) {
  console.error("usage: pnpm report <set-folder>   (a folder made by `pnpm runs`, e.g. .runs/real-<label>)");
  process.exit(2);
}
const setDir = path.resolve(SPIKE_ROOT, arg);
const manifest = await readManifest(setDir);
const runs = await loadRuns(setDir);
if (runs.length === 0) {
  console.error(`no runs with a record in ${setDir}`);
  process.exit(2);
}
if (manifest !== undefined) {
  console.log(`${manifest.mode} set "${manifest.label}": model ${manifest.model.id} (${manifest.model.format}), OpenCode ${manifest.agent.version}, policy ${manifest.policy}, pricing ${manifest.pricing}\n`);
}
console.log(formatRunTable(runs.map((run) => run.record)));
