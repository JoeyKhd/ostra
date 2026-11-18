// `pnpm spike`: runs every pass-bar criterion it can on this machine and
// prints PASS, FAIL or SKIPPED per criterion, with the checks under each.
// Options: --only=T3,T9,B3 runs a subset. SPIKE_LONG=1 adds the long runs.
// --allow-skipped exits 0 when nothing failed, even if a bullet was skipped.
// Exit codes: 1 when a bullet failed (or an error escaped a case), 2 when none
// failed but one was skipped, 0 when every bullet passed.
// Leaves no process behind: every task is stopped, and a final sweep (also on
// Ctrl+C or SIGTERM) kills anything this run started that is still alive.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { listProcesses, killTree, type ProcessInfo } from "../lib/process-tree.ts";
import { cases } from "../cases/index.ts";
import { createCaseContext, errorMessage, startModelSide, trackedProcesses, type ModelSide } from "./fixture.ts";
import { loadInputs } from "./inputs.ts";
import { passBar } from "./pass-bar.ts";
import { fail, formatCriterion, statusOf, type Criterion } from "./report.ts";
import { statusTables } from "./status-table.ts";

const spikeRoot = path.resolve(import.meta.dirname, "..", "..");
const runsDir = path.join(spikeRoot, ".runs");
const only = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => s !== "");
const allowSkipped = process.argv.includes("--allow-skipped");

// A stray socket error in one case must not take down the run and strand its agents.
const uncaught: string[] = [];
process.on("uncaughtException", (error) => {
  uncaught.push(error.message);
  console.error(`uncaught (run continues): ${error.message}`);
});

/**
 * Keeps the newest runs and the ones README.md cites; deletes the rest. Each
 * run holds per-task OpenCode data dirs and caches, so `.runs` grows by
 * hundreds of MB per run otherwise.
 */
const KEEP_NEWEST = 3;
const pruneRuns = async (): Promise<number> => {
  const readme = await readFile(path.join(spikeRoot, "README.md"), "utf8").catch(() => "");
  const cited = new Set(readme.match(/(?:run|probe)-[A-Za-z0-9-]+/g) ?? []);
  const entries = await readdir(runsDir).catch((): string[] => []);
  let removed = 0;
  for (const prefix of ["run-", "probe-"]) {
    const names = entries.filter((name) => name.startsWith(prefix)).sort().reverse();
    for (const name of names.slice(KEEP_NEWEST)) {
      if (cited.has(name)) continue;
      await rm(path.join(runsDir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
};

const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
const runRoot = path.join(runsDir, `run-${stamp}-${randomBytes(2).toString("hex")}`);
const runMarker = `ostra-marker-${path.basename(runRoot).slice(-13)}`;

/**
 * The final sweep: nothing this run started may outlive it. It touches only
 * this run's processes, so another run, or another program, is left alone:
 *   - a tracked PID, only if the live process is OpenCode or Node and was
 *     created when this run spawned it (a reused PID has a later creation time);
 *   - any process whose command line holds this run's folder or marker.
 */
const SPAWN_WINDOW_MS = 5000;
const isOurs = (p: ProcessInfo, tracked: ReadonlyMap<number, number>): boolean => {
  if (p.pid === process.pid) return false;
  if (p.commandLine.includes(runRoot) || p.commandLine.includes(runMarker)) return true;
  const spawnedAt = tracked.get(p.pid);
  return spawnedAt !== undefined && /opencode|node/i.test(p.name) && p.startedAt !== 0 && Math.abs(p.startedAt - spawnedAt) <= SPAWN_WINDOW_MS;
};
const sweep = async (): Promise<number> => {
  const tracked = new Map(trackedProcesses().map((t) => [t.pid, t.spawnedAt]));
  const leftovers = (await listProcesses().catch((): ProcessInfo[] => [])).filter((p) => isOurs(p, tracked));
  for (const p of leftovers) await killTree(p.pid);
  return leftovers.length;
};

// Set once the stubs are up, for the signal handler to close.
const running: { modelSide: ModelSide | undefined } = { modelSide: undefined };
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n${signal}: stopping; sweeping this run's processes`);
    void (async () => {
      await running.modelSide?.close().catch(() => undefined);
      const killed = await sweep();
      console.error(`sweep after ${signal}: ${String(killed)} processes killed`);
      process.exit(130);
    })();
  });
}

const pruned = await pruneRuns();
await mkdir(runRoot, { recursive: true });

const inputs = await loadInputs();
const modelSide = await startModelSide();
running.modelSide = modelSide;
const ctx = createCaseContext(runRoot, inputs, modelSide);

console.log(`spike 1: how-should-the-runner-drive-opencode — ${process.platform} ${process.arch}, Node ${process.version}`);
console.log(`run folder: ${runRoot}${pruned > 0 ? ` (pruned ${String(pruned)} old run folders)` : ""}`);
console.log(`model endpoint: ${inputs.model === undefined ? "missing" : `present (${inputs.modelSource})`}; SPIKE_LONG ${inputs.long ? "on" : "off"}\n`);

const results: Criterion[] = [];
for (const entry of cases) {
  if (only !== undefined && !entry.ids.some((id) => only.includes(id))) continue;
  const started = Date.now();
  let produced: Criterion[];
  try {
    produced = await entry.run(ctx);
  } catch (error) {
    produced = entry.ids.map((id) => ({ id, title: entry.title, checks: [fail("the case ran", errorMessage(error))] }));
  }
  for (const criterion of produced) {
    results.push(criterion);
    console.log(formatCriterion(criterion));
  }
  console.log(`          (${entry.ids.join(", ")} took ${String(Math.round((Date.now() - started) / 1000))} s)\n`);
}

await modelSide.close();
const leftovers = await sweep();

const bar = await passBar(results);
console.log("pass bar (context/build-order.md, spike 1)\n");
for (const criterion of bar) if (criterion.id !== "B3" && criterion.id !== "B4") console.log(`${formatCriterion(criterion)}\n`);

console.log("summary");
for (const criterion of bar) console.log(`  ${statusOf(criterion.checks).padEnd(7)} ${criterion.id} ${criterion.title}`);
for (const criterion of results) if (!criterion.id.startsWith("B")) console.log(`  ${statusOf(criterion.checks).padEnd(7)} ${criterion.id} ${criterion.title}`);
if (uncaught.length > 0) console.log(`uncaught errors during the run: ${String(uncaught.length)}`);
console.log(`final sweep: ${String(leftovers)} leftover processes killed`);
const report = { platform: process.platform, arch: process.arch, node: process.version, at: new Date().toISOString(), run: path.basename(runRoot), passBar: bar, results, leftovers, uncaught };
await writeFile(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(runRoot, "status.md"), statusTables(report));
console.log(`status tables: ${path.join(runRoot, "status.md")}`);

const failed = bar.some((r) => statusOf(r.checks) === "FAIL") || uncaught.length > 0;
const skipped = bar.some((r) => statusOf(r.checks) === "SKIPPED");
process.exitCode = failed ? 1 : skipped && !allowSkipped ? 2 : 0;
if (!failed && skipped) console.log(allowSkipped ? "some bullets were SKIPPED (--allow-skipped: exit 0)" : "some bullets were SKIPPED: exit 2 (pass --allow-skipped to accept)");
