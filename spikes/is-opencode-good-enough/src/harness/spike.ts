// `pnpm spike`: runs every pass-bar criterion it can on this machine and prints
// PASS, FAIL or SKIPPED per criterion, with the checks under each.
//
// What always runs (no model, no cost): the typecheck, the oracle (every ticket
// is unsolved on the pristine sample and solved by its reference solution, and
// the checkers catch the ways a run goes wrong), a dry-run of all 30 runs
// against a scripted stub model through the real ACP driver and key proxy, the
// cap, time-limit and resume paths, and the blind sheet and the scorer on the
// dry-run's output.
//
// What never runs from here: the real runs. They spend tokens, so
// `pnpm runs --real --host-run` starts them, and this command only reports on them once
// they are in .runs/real-*. The human rating needs a person.
//
// Options: --quick (4 tickets, 1 run each, a few seconds) and --allow-skipped
// (exit 0 when nothing failed, even if a bullet was skipped).
// Exit codes: 1 when a bullet failed, 2 when none failed but one was skipped, 0 when every bullet passed.
// Leaves no process behind: every task is stopped, and a final sweep (also on
// Ctrl+C or SIGTERM) kills anything this run started that is still alive.

import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { buildSheet } from "../rating/make-sheet.ts";
import { resolveOpenCodeBinary } from "../lib/opencode.ts";
import { dryOptions } from "../runner/modes.ts";
import { exec } from "../runner/exec.ts";
import { ALLOW_EVERYTHING_RULES } from "../runner/policy.ts";
import { findLeftovers, sweep, type OwnedProcess } from "../runner/processes.ts";
import { cleanWorkRoot, hostToolEnv } from "../runner/sandbox.ts";
import { startStubModelServer } from "../lib/stub-models/server.ts";
import { usdOf, type Pricing } from "../runner/pricing.ts";
import { executeRun, STUB_MODEL, type RunLimits } from "../runner/run-ticket.ts";
import type { RunRecord } from "../runner/schemas.ts";
import { runSet } from "../runner/run-set.ts";
import { createSolveBrain } from "../runner/stub-brain.ts";
import { removeDir, SPIKE_ROOT, TSC_BIN } from "../runner/workspace.ts";
import { ticketId } from "../tickets/schema.ts";
import { buildSolution, ESCAPE_TARGET } from "../tickets/solutions.ts";
import { TICKETS, ticketById } from "../tickets/tickets.ts";
import { dryRunChecks, escapeCheck, guardCheck, oracleChecks, scorerCheck, sheetChecks, ticketMixCheck, type EscapeRun, type Guard } from "./criteria.ts";
import { loadInputs } from "./inputs.ts";
import { runOracle } from "./oracle.ts";
import { realRatingChecks, realRecordingChecks, realRunChecks, type RealScan } from "./real-criteria.ts";
import { findRealSets, findRealSheet } from "./real-sets.ts";
import { check, fail, formatCriterion, pass, statusOf, type Check, type Criterion } from "./report.ts";
import { formatRunTable } from "./report-table.ts";
import { scanForSecrets } from "./scan.ts";
import { statusTables } from "./status-table.ts";
import { toolCallResults } from "./tool-calls.ts";

const runsDir = path.join(SPIKE_ROOT, ".runs");
const quick = process.argv.includes("--quick");
const allowSkipped = process.argv.includes("--allow-skipped");

// A stray socket error in one run must not take down the harness and strand its agents.
const uncaught: string[] = [];
process.on("uncaughtException", (error) => {
  uncaught.push(error.message);
  console.error(`uncaught (the run continues): ${error.message}`);
});

const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
const runRoot = path.join(runsDir, `spike-${stamp}-${randomBytes(2).toString("hex")}`);

/** Keeps the newest few spike folders and the ones README.md cites; deletes the rest. */
const KEEP_NEWEST = 3;
const pruneRuns = async (): Promise<number> => {
  const readme = await readFile(path.join(SPIKE_ROOT, "README.md"), "utf8").catch(() => "");
  const cited = new Set(readme.match(/spike-[0-9T-]+-[0-9a-f]{4}/g) ?? []);
  const names = (await readdir(runsDir).catch((): string[] => [])).filter((name) => name.startsWith("spike-") || name.startsWith("oracle-")).sort().reverse();
  let removed = 0;
  for (const name of names.slice(KEEP_NEWEST)) {
    if (cited.has(name)) continue;
    await rm(path.join(runsDir, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    removed += 1;
  }
  return removed;
};

let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n${signal}: stopping; sweeping this run's processes`);
    void sweep([runRoot]).then((killed) => {
      console.error(`sweep after ${signal}: ${String(killed)} processes killed`);
      process.exit(130);
    });
  });
}

const pruned = await pruneRuns();
await mkdir(runRoot, { recursive: true });
const inputs = await loadInputs();
const binary = await resolveOpenCodeBinary("v2");

console.log(`spike 10: is-opencode-good-enough: ${process.platform} ${process.arch}, Node ${process.version}, OpenCode ${binary.packageVersion}${quick ? " (--quick)" : ""}`);
console.log(`run folder: ${runRoot}${pruned > 0 ? ` (pruned ${String(pruned)} old folders)` : ""}`);
console.log(`model endpoint: ${inputs.model === undefined ? "missing" : `present (${inputs.modelSource})`}; no real run is started from here\n`);

const stage = async <T,>(name: string, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  const started = Date.now();
  try {
    const value = await work();
    console.log(`  (${name}: ${((Date.now() - started) / 1000).toFixed(0)} s)`);
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  (${name}: failed after ${((Date.now() - started) / 1000).toFixed(0)} s: ${message.slice(0, 200)})`);
    return { ok: false, error: message };
  }
};

const failed = (name: string, error: string): Check => fail(name, `the stage did not run: ${error}`);

// --- 1. the typecheck, always ---------------------------------------------------------------
console.log("typecheck");
const typecheck = await stage("typecheck", async () => exec(process.execPath, [TSC_BIN, "--noEmit", "-p", "tsconfig.json"], { cwd: SPIKE_ROOT, timeoutMs: 180_000, env: await hostToolEnv() }));
const typecheckCheck: Check = typecheck.ok
  ? typecheck.value.code === 0
    ? pass("strict typecheck of the spike and the sample repo (tsc --noEmit)", "clean")
    : fail("strict typecheck of the spike and the sample repo (tsc --noEmit)", `${String((typecheck.value.stdout.match(/error TS\d+/g) ?? []).length)} errors`)
  : failed("typecheck", typecheck.error);

// --- 2. the oracle --------------------------------------------------------------------------
console.log("the oracle (no agent)");
const QUICK_TICKETS = ["calc-1", "calc-5", "calc-6", "calc-9"];
const oracle = await stage("oracle", async () => runOracle(path.join(runRoot, "oracle"), quick ? QUICK_TICKETS : undefined));
const oracleResult = oracle.ok ? oracleChecks(oracle.value.outcomes) : undefined;

// --- 3. the dry-run -------------------------------------------------------------------------
console.log("the dry-run: scripted stub model, OpenCode, the ACP driver, the key proxy");
const tickets = quick ? TICKETS.filter((t) => QUICK_TICKETS.includes(t.id)) : TICKETS;
const runsPerTicket = quick ? 1 : 3;
const expectedRuns = tickets.length * runsPerTicket;
const dryDir = path.join(runRoot, "dry");
const dryLimits: RunLimits = { timeoutMs: 5 * 60_000, maxTokens: 5_000_000, maxUsd: undefined };
const quietLog = (): void => undefined;
const dry = await stage("dry-run", async () => {
  await mkdir(dryDir, { recursive: true });
  return runSet(
    dryOptions({
      setDir: dryDir,
      tickets,
      runsPerTicket,
      concurrency: 3,
      limits: dryLimits,
      binary,
      log: quietLog,
      onRecord: (r) => {
        console.log(`    ${r.runId} ${r.variant ?? ""} ${r.outcome} ${(r.time.wallMs / 1000).toFixed(1)} s, CI ${r.checks.ci.green ? "green" : "RED"}, acceptance ${r.checks.acceptance.passed ? "pass" : "fail"}`);
      },
      stopRequested: () => interrupted,
    }),
  );
});
const records: readonly RunRecord[] = dry.ok ? dry.value.records : [];
const dryResult = dry.ok ? dryRunChecks(records, expectedRuns, dry.value.failed) : undefined;
if (records.length > 0) console.log(`\n${formatRunTable(records)}\n`);

// --- 4. guards and resume -------------------------------------------------------------------
console.log("the guards, and resume");
const guards = await stage("guards", async () => {
  const guardsDir = path.join(runRoot, "guards");
  const ticket = ticketById(ticketId("calc-1"));
  if (ticket === undefined) throw new Error("calc-1 is missing");
  const slow = (index: number, limits: RunLimits): Promise<RunRecord> =>
    executeRun({ runsDir: guardsDir, label: "guards", ticket, index, model: { kind: "stub", format: "openai", variant: "good", stepDelayMs: 400 }, limits, binary }, quietLog);
  const found: Guard[] = [];
  found.push({ name: "token cap", record: await slow(1, { timeoutMs: 60_000, maxTokens: 12_000, maxUsd: undefined, watchMs: 100 }), wanted: "token-cap" });
  found.push({ name: "dollar cap", record: await slow(2, { timeoutMs: 60_000, maxTokens: 5_000_000, maxUsd: 0.03, watchMs: 100 }), wanted: "spend-cap" });
  found.push({ name: "time limit", record: await slow(3, { timeoutMs: 1_000, maxTokens: 5_000_000, maxUsd: undefined, watchMs: 100 }), wanted: "timeout" });
  return found;
});

// The agent's file tools must not leave the workspace. The same script (it writes a file outside the workspace and reads one)
// runs twice: under `allow *` alone, where both must work (the control: it shows the script reaches what it aims at), and
// under the policy's rules, where both must fail. A failure under the rules means something only with the control behind it.
const escape = await stage("escape", async () => {
  const ticket = ticketById(ticketId("calc-1"));
  if (ticket === undefined) throw new Error("calc-1 is missing");
  const attempt = async (index: number, rules: typeof ALLOW_EVERYTHING_RULES | undefined): Promise<EscapeRun> => {
    await rm(ESCAPE_TARGET, { force: true });
    const guardsDir = path.join(runRoot, "guards");
    const record = await executeRun(
      { runsDir: guardsDir, label: "guards", ticket, index, model: { kind: "stub", format: "openai", variant: "escape" }, limits: dryLimits, binary, ...(rules === undefined ? {} : { permissions: rules }) },
      quietLog,
    );
    const landed = await access(ESCAPE_TARGET).then(
      () => true,
      () => false,
    );
    await rm(ESCAPE_TARGET, { force: true });
    const calls = toolCallResults(await readFile(path.join(guardsDir, record.runId, "events.jsonl"), "utf8"));
    return { record, landed, calls };
  };
  const control = await attempt(5, ALLOW_EVERYTHING_RULES);
  const refused = await attempt(4, undefined);
  return { control, refused };
});

// The path a real run takes, against a local stand-in for the endpoint: an endpoint with a key and a price list.
// The stand-in accepts only its own key, which the agent never holds, so a run that completes shows the proxy swapped the key.
const endpointPath = await stage("endpoint path", async () => {
  const ticket = ticketById(ticketId("calc-1"));
  const solution = ticket === undefined ? undefined : await buildSolution(ticket.id, "good");
  if (ticket === undefined || solution === undefined) throw new Error("calc-1 is missing");
  const dir = path.join(runRoot, "endpoint-path");
  const standInKey = `stand-in-${randomBytes(12).toString("hex")}`;
  const stub = await startStubModelServer({ format: "openai", realKey: standInKey, models: [STUB_MODEL], brain: createSolveBrain(solution) });
  try {
    const pricing: Pricing = { source: "configured", inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 };
    const record = await executeRun(
      { runsDir: dir, label: "stand-in", ticket, index: 1, model: { kind: "endpoint", endpoint: { baseUrl: stub.baseUrl, apiKey: standInKey, modelId: STUB_MODEL }, format: "openai", pricing, limits: { context: 64_000, output: 8000 } }, limits: dryLimits, binary },
      quietLog,
    );
    const scan = await scanForSecrets(dir, [standInKey]);
    return { record, scan, pricing, calls: stub.calls.length, rejected: stub.calls.filter((call) => !call.authOk).length };
  } finally {
    await stub.close();
  }
});

const resume = await stage("resume", async () => {
  let executed = 0;
  const again = await runSet(
    dryOptions({
      setDir: dryDir,
      tickets,
      runsPerTicket,
      concurrency: 3,
      limits: dryLimits,
      binary,
      log: quietLog,
      onRecord: () => {
        executed += 1;
      },
    }),
  );
  return { executed, reused: again.reused.length };
});

// --- 5. the blind sheet and the scorer, on the dry-run's output -----------------------------
console.log("the blind sheet and the scorer");
const rating = await stage("sheet", async () => {
  const seed = 20_261_118;
  const sheet = await buildSheet({ setDirs: [dryDir], outDir: path.join(runRoot, "rating"), seed });
  const again = await buildSheet({ setDirs: [dryDir], outDir: path.join(runRoot, "rating-again"), seed, now: new Date(sheet.key.createdAt) });
  const other = await buildSheet({ setDirs: [dryDir], outDir: path.join(runRoot, "rating-other"), seed: seed + 1 });
  return { sheet, again, other };
});
const sheetResult = rating.ok ? sheetChecks(rating.value.sheet, rating.value.again, rating.value.other, records) : undefined;
const scorerResult = rating.ok ? scorerCheck(rating.value.sheet.key) : undefined;

// --- 6. what the real runs left, if anything ------------------------------------------------
const realSets = await findRealSets();
const realSheet = await findRealSheet(realSets);

// --- 7. nothing left behind -----------------------------------------------------------------
const needles: (string | RegExp)[] = [/stub-real-[0-9a-f]{32}/, /ostra-fake-[A-Za-z0-9_-]{20,}/];
const scanned = await scanForSecrets(runRoot, needles);
const realScan: RealScan[] | undefined = inputs.model === undefined ? undefined : await Promise.all(realSets.map(async (s) => ({ rel: s.rel, ...(await scanForSecrets(s.dir, [inputs.model?.apiKey ?? ""])) })));
const leftovers = await findLeftovers([runRoot]);
const killed = await sweep([runRoot]);

/** What the sweep found, by program and by why it is ours: never a command line. */
const describeLeftovers = (found: readonly OwnedProcess[]): string => {
  const counts = new Map<string, number>();
  for (const o of found) counts.set(`${o.process.name} ${o.reason}`, (counts.get(`${o.process.name} ${o.reason}`) ?? 0) + 1);
  return [...counts.entries()].map(([what, n]) => `${String(n)} x ${what}`).join(", ");
};

const builds = (...parts: (Check | undefined)[]): Check[] => parts.filter((p): p is Check => p !== undefined);

// --- the pass bar ---------------------------------------------------------------------------
const realRuns = realRunChecks(realSets);
const realRating = realRatingChecks(realSets, realSheet);
const realRecording = realRecordingChecks(realSets, realScan);

const passBar: Criterion[] = [
  {
    id: "B1",
    title: "10 tickets (3 bug fixes, 3 small features, 2 refactors, 2 that add tests), three runs each, on the model in model.env.",
    checks: [
      ticketMixCheck(),
      ...(oracleResult === undefined ? [failed("the oracle", oracle.ok ? "" : oracle.error)] : [oracleResult.baseFails, oracleResult.referencePasses]),
      ...realRuns,
    ],
  },
  {
    id: "B2",
    title: "Rated blind: at least half are \"merge as it is\" or \"merge with small edits\" (working value).",
    checks: [
      ...(sheetResult === undefined ? [failed("the blind sheet", rating.ok ? "" : rating.error)] : [sheetResult.blind, sheetResult.order, sheetResult.key]),
      ...(scorerResult === undefined ? [failed("the scorer", rating.ok ? "" : rating.error)] : [scorerResult]),
      ...realRating,
    ],
  },
  {
    id: "B3",
    title: "Recorded per run: spend from the proxy, time, turns, approvals and events.",
    checks: [
      ...(dryResult === undefined ? [failed("the dry-run", dry.ok ? "" : dry.error)] : [dryResult.recording, dryResult.meter, dryResult.paths]),
      ...realRecording,
    ],
  },
];

// --- the pipeline, proven on the dry-run ----------------------------------------------------
type EndpointPath = { record: RunRecord; scan: { files: number; hits: readonly string[] }; pricing: Pricing; calls: number; rejected: number };

const endpointPathCheck = (e: EndpointPath): Check => {
  const r = e.record;
  const expected = usdOf({ input: r.spend.inputTokens, output: r.spend.outputTokens, cacheRead: r.spend.cacheReadTokens, cacheWrite: r.spend.cacheWriteTokens, reasoning: 0 }, e.pricing);
  const priced = r.spend.usd !== null && Math.abs(r.spend.usd - expected) < 1e-9;
  return check(
    "the path a real run takes works against a local stand-in endpoint: the key is swapped in, spend is priced from configured prices, the key is in no record",
    r.mode === "real" && r.outcome === "completed" && r.checks.acceptance.passed && r.spend.pricing === "configured" && priced && e.scan.hits.length === 0 && e.rejected === 0 && e.calls > 0,
    `${String(e.calls)} calls reached the stand-in, which takes only its own key (${String(e.rejected)} refused), so the proxy swapped the agent's fake key; run ${r.outcome}; dollars ${priced ? "follow" : "DO NOT follow"} from the configured prices; ${String(e.scan.files)} files scanned, ${e.scan.hits.length === 0 ? "the stand-in's key is in none" : "THE KEY IS IN " + e.scan.hits.join(", ")}`,
  );
};

const pipeline: Criterion = {
  id: "P1",
  title: "The pipeline, proven on the dry-run (a scripted stub model: it says nothing about any real model).",
  checks: builds(
    typecheckCheck,
    oracleResult?.variants,
    dryResult?.completed,
    dryResult?.formats,
    dryResult?.verdicts,
    guards.ok ? guardCheck(guards.value) : failed("the guards", guards.error),
    escape.ok ? escapeCheck(escape.value.control, escape.value.refused) : failed("escape", escape.error),
    endpointPath.ok ? endpointPathCheck(endpointPath.value) : failed("the endpoint path", endpointPath.error),
    resume.ok
      ? { name: "a resumed set keeps its recorded runs and runs nothing again", status: resume.value.executed === 0 && resume.value.reused === expectedRuns ? ("PASS" as const) : ("FAIL" as const), note: `${String(resume.value.reused)} of ${String(expectedRuns)} runs reused, ${String(resume.value.executed)} run again` }
      : failed("resume", resume.error),
    scanned.hits.length === 0 ? pass("no key, real or fake, in any record the harness wrote", `${String(scanned.files)} files scanned for the stub's real keys and the proxy's fake keys`) : fail("no key, real or fake, in any record the harness wrote", `found in ${scanned.hits.slice(0, 5).join(", ")}`),
    leftovers.length === 0 && killed === 0 ? pass("no process left behind", "the final sweep found none of this run's agents or tool processes alive") : fail("no process left behind", `${String(leftovers.length)} found and ${String(killed)} killed by the final sweep (${describeLeftovers(leftovers)})`),
    uncaught.length === 0 ? pass("no uncaught error", "none") : fail("no uncaught error", uncaught.slice(0, 3).join("; ")),
  ),
};

const results: Criterion[] = [...passBar, pipeline];
for (const criterion of results) console.log(`${formatCriterion(criterion)}\n`);

console.log("summary");
for (const criterion of results) console.log(`  ${statusOf(criterion.checks).padEnd(7)} ${criterion.id} ${criterion.title}`);
console.log(`final sweep: ${String(killed)} leftover processes killed`);

const report = { platform: process.platform, arch: process.arch, node: process.version, opencode: binary.packageVersion, at: new Date().toISOString(), run: path.basename(runRoot), quick, passBar, pipeline, dryRunRecords: records.length };
await writeFile(path.join(runRoot, "report.json"), JSON.stringify(report, null, 2));
await writeFile(path.join(runRoot, "status.md"), statusTables(report));
console.log(`status tables: ${path.join(runRoot, "status.md")}`);
await removeDir(path.join(runRoot, "oracle")).catch(() => undefined);
await cleanWorkRoot().catch(() => undefined);

const anyFailed = results.some((r) => statusOf(r.checks) === "FAIL");
const anySkipped = passBar.some((r) => statusOf(r.checks) === "SKIPPED");
process.exitCode = anyFailed ? 1 : anySkipped && !allowSkipped ? 2 : 0;
if (!anyFailed && anySkipped) console.log(allowSkipped ? "some bullets were SKIPPED (--allow-skipped: exit 0)" : "some bullets were SKIPPED: exit 2 (pass --allow-skipped to accept)");
