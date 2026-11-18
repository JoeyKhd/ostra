// `pnpm spike`: runs every pass-bar criterion it can on this machine and
// prints PASS, FAIL or SKIPPED per bullet, with the checks under each.
//   --only=stub,model,patch,long,container,github   a subset of the runs
//                                                   (stub:chatty, model:chatty and patch:far|up|down name their group)
//   --turns=N                                       the long sessions' length (default 200)
//   --allow-skipped                                 exit 0 when nothing failed, even if a bullet was skipped
// Exit codes: 1 when a bullet failed or the process check failed, 2 when none
// failed but one was skipped, 0 when every bullet passed.
// Leaves no process behind: every box is destroyed, and a final sweep (also on
// Ctrl+C or SIGTERM) kills anything this run started that is still alive. The
// sweep is a check of its own: a process it had to kill, one that survived
// the kill, or a process list it couldn't read fails the run.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runLongSession, LONG_TURNS, type LongSessionResult } from "../cases/long-session.ts";
import { runMove, type MoveResult } from "../cases/move.ts";
import { githubHiddenRefChecks } from "../cases/github-ref.ts";
import { isAlive } from "../lib/process-tree.ts";
import { closeRunContext, errorMessage, startRunContext, sweep, sweepClean, type SweepResult } from "./fixture.ts";
import { detectApiFormat, loadInputs } from "./inputs.ts";
import { passBar, RUN_GROUPS, type Results, type RunGroup } from "./pass-bar.ts";
import { formatCriterion, statusOf } from "./report.ts";
import { statusTable } from "./status-table.ts";

const spikeRoot = path.resolve(import.meta.dirname, "..", "..");
const runsDir = path.join(spikeRoot, ".runs");

// --- arguments, validated at the boundary ---------------------------------

/** A run's own name (`stub:chatty`, `patch:up`) selects its group. */
const RunNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((name) => name.split(":")[0] ?? name)
  .pipe(z.enum(RUN_GROUPS));
const OnlySchema = z.array(RunNameSchema).min(1);

const onlyArg = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
const onlyParsed = onlyArg === undefined ? undefined : OnlySchema.safeParse(onlyArg.split(","));
if (onlyParsed?.success === false) {
  console.error(`--only: each name must be one of ${RUN_GROUPS.join(", ")} (or stub:chatty, model:chatty, patch:far, patch:up, patch:down)`);
  process.exit(64);
}
const only: ReadonlySet<RunGroup> | undefined = onlyParsed?.success === true ? new Set(onlyParsed.data) : undefined;

const turnsArg = process.argv.find((arg) => arg.startsWith("--turns="))?.slice("--turns=".length);
const turnsParsed = z.coerce.number().int().min(2).max(2000).safeParse(turnsArg ?? LONG_TURNS);
if (!turnsParsed.success) {
  console.error("--turns must be an integer from 2 to 2000");
  process.exit(64);
}
const longTurns = turnsParsed.data;
const allowSkipped = process.argv.includes("--allow-skipped");
const known = /^--(?:only|turns)=|^--allow-skipped$|^--$/;
const unknownArgs = process.argv.slice(2).filter((arg) => !known.test(arg));
if (unknownArgs.length > 0) {
  console.error(`unknown arguments: ${String(unknownArgs.length)} (see the header of src/harness/spike.ts)`);
  process.exit(64);
}
const wants = (group: RunGroup): boolean => only === undefined || only.has(group);

const uncaught: string[] = [];
process.on("uncaughtException", (error) => {
  uncaught.push(error.message);
  console.error(`uncaught (run continues): ${error.message}`);
});

// --- the run folder -------------------------------------------------------

/** In a run folder while its run is going: the PID, so a parallel run's prune leaves it alone. */
const RUNNING_FILE = ".running";

const stillRunning = async (dir: string): Promise<boolean> => {
  const text = await readFile(path.join(dir, RUNNING_FILE), "utf8").catch(() => undefined);
  if (text === undefined) return false;
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 && isAlive(pid);
};

/** Keeps the newest runs, the ones README.md cites and any still running; deletes the rest. */
const KEEP_NEWEST = 3;
const pruneRuns = async (): Promise<void> => {
  const readme = await readFile(path.join(spikeRoot, "README.md"), "utf8").catch(() => "");
  const cited = new Set(readme.match(/run-[A-Za-z0-9-]+/g) ?? []);
  const names = (await readdir(runsDir).catch((): string[] => [])).filter((n) => n.startsWith("run-")).sort().reverse();
  for (const name of names.slice(KEEP_NEWEST)) {
    if (cited.has(name)) continue;
    const dir = path.join(runsDir, name);
    if (await stillRunning(dir)) continue;
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
};

const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
const runRoot = path.join(runsDir, `run-${stamp}-${randomBytes(2).toString("hex")}`);
await mkdir(runRoot, { recursive: true });
await writeFile(path.join(runRoot, RUNNING_FILE), String(process.pid));
await pruneRuns();

const inputs = await loadInputs();
const ctx = await startRunContext(runRoot, inputs);

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n${signal}: stopping; sweeping this run's processes`);
    void (async () => {
      await closeRunContext(ctx).catch(() => undefined);
      const swept = await sweep(ctx);
      console.error(`sweep after ${signal}: ${swept.error === undefined ? `${String(swept.killed)} processes killed, ${String(swept.containers)} containers removed, ${String(swept.survivors)} survived` : `FAILED: ${swept.error}`}`);
      await rm(path.join(runRoot, RUNNING_FILE), { force: true }).catch(() => undefined);
      process.exit(130);
    })();
  });
}

console.log(`spike 2: can-a-session-move-to-a-fresh-box — ${process.platform} ${process.arch}, Node ${process.version}`);
console.log(`run folder: ${runRoot}`);
console.log(`model endpoint: ${inputs.model === undefined ? "missing" : `present (${inputs.modelSource})`}; GitHub: ${inputs.githubMissing.length === 0 ? "present" : "missing"}; Docker: ${inputs.docker ? "answers" : "missing"}\n`);

const timed = async <T,>(name: string, group: RunGroup, work: () => Promise<T>): Promise<T | undefined> => {
  if (!wants(group)) return undefined;
  const started = Date.now();
  console.log(`running ${name} …`);
  try {
    return await work();
  } catch (error) {
    console.log(`  ${name} threw: ${errorMessage(error)}`);
    return undefined;
  } finally {
    console.log(`  ${name} took ${String(Math.round((Date.now() - started) / 1000))} s`);
  }
};

const brief = (result: MoveResult | undefined): string =>
  result === undefined
    ? "did not run"
    : (result.error ?? result.restoreError ?? `restored; ${String(result.restored?.score.correct ?? 0)}/5; edit finished: ${String(result.restored?.finish.finished ?? false)}${result.template === undefined ? "" : `; template ${String(result.template.score.correct)}/5`}`);

const briefLong = (long: LongSessionResult | undefined): string =>
  long === undefined ? "did not run" : (long.error ?? `restored in ${String(long.totalMs)} ms; ${String(long.compactionCalls)} compaction calls; turn 1 answered: ${String(long.recalled)}`);

const stub = await timed("stub", "stub", async () => runMove(ctx, { label: "stub", from: "2.3.2", to: "2.3.2", upstream: { kind: "stub" }, control: true, template: true, elsewhere: true }));
console.log(`  ${brief(stub)}`);
const stubChatty = await timed("stub:chatty", "stub", async () => runMove(ctx, { label: "chatty", from: "2.3.2", to: "2.3.2", upstream: { kind: "stub" }, control: false, template: true, elsewhere: false, chatty: true }));
console.log(`  ${brief(stubChatty)}`);
const endpoint = inputs.model;
const model =
  endpoint === undefined
    ? undefined
    : await timed("model", "model", async () => runMove(ctx, { label: "model", from: "2.3.2", to: "2.3.2", upstream: { kind: "endpoint", endpoint, format: await detectApiFormat(endpoint) }, control: false, template: true, elsewhere: false }));
if (endpoint !== undefined && wants("model")) console.log(`  ${brief(model)}`);
const modelChatty =
  endpoint === undefined
    ? undefined
    : await timed("model:chatty", "model", async () =>
        runMove(ctx, { label: "mchatty", from: "2.3.2", to: "2.3.2", upstream: { kind: "endpoint", endpoint, format: await detectApiFormat(endpoint) }, control: false, template: true, elsewhere: false, chatty: true }),
      );
if (endpoint !== undefined && wants("model")) console.log(`  ${brief(modelChatty)}`);
const patchFar = await timed("patch:far", "patch", async () => runMove(ctx, { label: "far", from: "2.3.0", to: "2.3.2", upstream: { kind: "stub" }, control: false, template: false, elsewhere: false }));
console.log(`  ${brief(patchFar)}`);
const patchUp = await timed("patch:up", "patch", async () => runMove(ctx, { label: "up", from: "2.3.1", to: "2.3.2", upstream: { kind: "stub" }, control: false, template: false, elsewhere: false }));
console.log(`  ${brief(patchUp)}`);
const patchDown = await timed("patch:down", "patch", async () => runMove(ctx, { label: "down", from: "2.3.2", to: "2.3.1", upstream: { kind: "stub" }, control: false, template: false, elsewhere: false }));
console.log(`  ${brief(patchDown)}`);
const container = inputs.docker
  ? await timed("container", "container", async () => runMove(ctx, { label: "ctr", from: "2.3.2", to: "2.3.2", upstream: { kind: "stub" }, control: true, template: false, elsewhere: false, executor: "container" }))
  : undefined;
if (inputs.docker && wants("container")) console.log(`  ${brief(container)}`);
const long = await timed("long", "long", async () => runLongSession(ctx, longTurns, false));
console.log(`  ${briefLong(long)}`);
const longCompacted = await timed("long:compaction", "long", async () => runLongSession(ctx, longTurns, true));
console.log(`  ${briefLong(longCompacted)}`);
const github = await timed("github", "github", async () => githubHiddenRefChecks(ctx));
console.log("");

await closeRunContext(ctx);
const swept: SweepResult = await sweep(ctx);
const processesOk = sweepClean(swept);

const notSelected = new Set(RUN_GROUPS.filter((group) => !wants(group)));
const results: Results = { inputs, stub, stubChatty, model, modelChatty, patchFar, patchUp, patchDown, container, long, longCompacted, github, notSelected };
const bar = passBar(results);
console.log("pass bar (context/build-order.md, spike 2)\n");
for (const criterion of bar) console.log(`${formatCriterion(criterion)}\n`);
console.log("summary");
for (const criterion of bar) console.log(`  ${statusOf(criterion.checks).padEnd(7)} ${criterion.id} ${criterion.title}`);
const sweepNote =
  swept.error === undefined
    ? `${String(swept.killed)} leftover processes killed, ${String(swept.containers)} leftover containers removed, ${String(swept.survivors)} still alive after the kill`
    : `the process list could not be read: ${swept.error}`;
console.log(`  ${(processesOk ? "PASS" : "FAIL").padEnd(7)} no process left behind (the final sweep: ${sweepNote})`);
if (uncaught.length > 0) console.log(`uncaught errors during the run: ${String(uncaught.length)}`);

// The run folder is gitignored. It holds the answers and agent text: session content, never printed above.
const details = { stub, stubChatty, model, modelChatty, patchFar, patchUp, patchDown, container, long, longCompacted, github };
const report = { platform: process.platform, arch: process.arch, node: process.version, at: new Date().toISOString(), run: path.basename(runRoot), passBar: bar, sweep: swept, processesOk, uncaught, details };
await writeFile(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(runRoot, "status.md"), `${statusTable(report.run, bar)}\nNo process left behind: ${processesOk ? "PASS" : "FAIL"} (${sweepNote}).\n`);
await rm(path.join(runRoot, RUNNING_FILE), { force: true });
console.log(`report: ${path.join(runRoot, "report.json")}`);

const failed = bar.some((r) => statusOf(r.checks) === "FAIL") || uncaught.length > 0 || !processesOk;
const skipped = bar.some((r) => statusOf(r.checks) === "SKIPPED");
process.exitCode = failed ? 1 : skipped && !allowSkipped ? 2 : 0;
if (!failed && skipped) console.log(allowSkipped ? "some bullets were SKIPPED (--allow-skipped: exit 0)" : "some bullets were SKIPPED: exit 2 (pass --allow-skipped to accept)");
