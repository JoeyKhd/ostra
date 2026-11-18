// `pnpm runs`: runs the tickets, three times each.
//
//   pnpm runs --dry                    a dry-run against the scripted stub model (no inputs, no cost)
//   pnpm runs --real --host-run        the real runs, on the endpoint in model.env (SPENDS TOKENS)
//   pnpm runs --real --host-run --tickets=calc-1 --runs=1     one run first, to see what a run costs
//
// A real run lets the model's shell run as your own account (nothing here
// isolates it), so --real refuses to start without --host-run (or
// OSTRA_SPIKE_HOST_RUN=1), which says you know what it can reach and that you
// are on a throwaway machine or a low-privilege account.
//
// Options: --tickets=calc-1,calc-4  --runs=3  --concurrency=N  --timeout-min=N
//   --max-tokens=N   stop a run that has used this many tokens (default 3,000,000)
//   --max-usd=N      the same, in dollars; needs prices (OSTRA_SPIKE_PRICE_INPUT and _OUTPUT), refused without them
//   --label=NAME     names the set (default: the model's ID); --set=FOLDER picks the folder
//   --fresh          starts the set again (deletes the folder first)
//   --retry-failed   redoes the recorded runs that ended in an error or a crash, or hit a model error (429, 5xx, 4xx)
// A real set is resumable: run the same command again and the runs that
// already have a record are kept, whatever their outcome, so an interrupted
// set doesn't pay twice. A run that hit a rate limit has a record too: it is
// redone only with --retry-failed.

import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadInputs, MODEL_INPUT_HINT } from "../harness/inputs.ts";
import { formatRunTable } from "../harness/report-table.ts";
import { resolveOpenCodeBinary } from "../lib/opencode.ts";
import { TICKETS } from "../tickets/tickets.ts";
import { dryOptions, realOptions } from "./modes.ts";
import { dollarCap } from "./pricing.ts";
import { sweep } from "./processes.ts";
import { needsRetry } from "./retry.ts";
import { runSet } from "./run-set.ts";
import { cleanWorkRoot, WORK_ROOT } from "./sandbox.ts";
import { removeDir, SPIKE_ROOT } from "./workspace.ts";

const flag = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3)
    .trim();
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const positive = (name: string, fallback: number): number => {
  const text = flag(name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(2);
  }
  return value;
};

const real = has("real");
if (real === has("dry")) {
  console.error("say which: --dry (scripted stub model, free) or --real (the model in model.env, spends tokens)");
  process.exit(2);
}

// The gate: a real run puts a model's shell on this machine, as this account. Nothing is read from model.env before it.
if (real && !has("host-run") && process.env["OSTRA_SPIKE_HOST_RUN"] !== "1") {
  const configDir = path.join(os.homedir(), ".config", "ostra-dev");
  console.error(
    [
      "refusing to start the real runs without --host-run (or OSTRA_SPIKE_HOST_RUN=1).",
      "",
      "The model's shell tool runs as your own account, with no sandbox. In reach of it, by absolute path:",
      `  - ${configDir}${path.sep}* : whatever it holds, such as model.env (the real model key: the proxy keeps it out of the agent's environment, not off the disk), a GitHub App private key (github-app-*.pem) and linear.env`,
      "  - this spike's hidden acceptance tests (src/tickets/acceptance/), its reference solutions (src/tickets/solutions.ts) and the earlier runs' diffs (.runs/)",
      "  - everything else your account can read or write",
      "The agent's workspace is in the OS temp folder, so `cd ..` does not lead to the spike, but nothing stops a path it has found.",
      "",
      "Run it on a throwaway machine, or as a separate low-privilege OS account that cannot read those folders, or (once it exists) in spike 3's box, with the model.env values set only in the environment of this command. Then pass --host-run.",
    ].join("\n"),
  );
  process.exit(2);
}

const wanted = flag("tickets")
  ?.split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s !== "");
const tickets = wanted === undefined ? TICKETS : TICKETS.filter((t) => wanted.includes(t.id));
if (tickets.length === 0 || (wanted !== undefined && tickets.length !== wanted.length)) {
  console.error(`unknown ticket in --tickets (known: ${TICKETS.map((t) => t.id).join(", ")})`);
  process.exit(2);
}
const runsPerTicket = Math.floor(positive("runs", 3));
const binary = await resolveOpenCodeBinary("v2");
const slug = (text: string): string => text.toLowerCase().replaceAll(/[^a-z0-9.-]+/g, "-").replaceAll(/^-+|-+$/g, "");

let interrupted = false;
const folders: string[] = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n${signal}: stopping; killing this run's agents (runs without a record are redone by the next resume)`);
    void sweep(folders).then((killed) => {
      console.error(`${String(killed)} processes killed`);
      process.exit(130);
    });
  });
}

const log = (line: Readonly<Record<string, string | number | boolean | null>>): void => {
  if (line["event"] === "run.failed") console.error(JSON.stringify(line));
};

if (!real) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\..+$/, "");
  const setDir = path.resolve(SPIKE_ROOT, flag("set") ?? path.join(".runs", `dry-${stamp}`));
  folders.push(setDir);
  if (has("fresh")) await removeDir(setDir);
  await mkdir(setDir, { recursive: true });
  console.log(`dry-run: ${String(tickets.length)} tickets x ${String(runsPerTicket)} runs against the scripted stub model, in ${setDir}`);
  const result = await runSet(
    dryOptions({
      setDir,
      tickets,
      runsPerTicket,
      concurrency: Math.floor(positive("concurrency", 3)),
      limits: { timeoutMs: positive("timeout-min", 5) * 60_000, maxTokens: positive("max-tokens", 5_000_000), maxUsd: undefined },
      binary,
      log,
      onRecord: (r) => {
        console.log(`  ${r.runId} ${r.variant ?? ""} ${r.outcome} ${(r.time.wallMs / 1000).toFixed(1)}s calls=${String(r.turns.modelCalls)} CI ${r.checks.ci.green ? "green" : "RED"} accept ${r.checks.acceptance.passed ? "pass" : "fail"}`);
      },
      stopRequested: () => interrupted,
    }),
  );
  console.log(`\n${formatRunTable(result.records)}`);
  console.log(`\n${String(result.failed.length)} runs failed to complete; ${String(await sweep(folders))} leftover processes killed`);
  process.exitCode = result.failed.length === 0 ? 0 : 1;
} else {
  const inputs = await loadInputs();
  if (inputs.model === undefined) {
    console.error(`the real runs need the model endpoint: ${MODEL_INPUT_HINT}
missing: ${inputs.modelMissing.join(", ")}`);
    process.exit(2);
  }
  const label = flag("label") ?? slug(inputs.model.modelId);
  const setDir = path.resolve(SPIKE_ROOT, flag("set") ?? path.join(".runs", `real-${label}`));
  folders.push(setDir);
  const requestedUsd = flag("max-usd") === undefined ? undefined : positive("max-usd", 5);
  const cap = dollarCap(requestedUsd, inputs.pricing);
  if (!cap.ok) {
    console.error(cap.message);
    process.exit(2);
  }
  const maxUsd = cap.maxUsd;
  const limits = { timeoutMs: positive("timeout-min", 20) * 60_000, maxTokens: positive("max-tokens", 3_000_000), maxUsd };
  const concurrency = Math.floor(positive("concurrency", 1));
  // The one request made before any run: the endpoint's model list, to learn its API format. It fails loudly (a 401, a 5xx, a body that is no model list), and before --fresh deletes anything.
  const options = await realOptions({
    retryFailed: has("retry-failed"),
    setDir,
    label,
    endpoint: inputs.model,
    inputs,
    tickets,
    runsPerTicket,
    concurrency,
    limits,
    binary,
    log,
    onRecord: (r) => {
      console.log(`  ${r.runId} ${r.outcome} ${(r.time.wallMs / 1000).toFixed(1)}s calls=${String(r.turns.modelCalls)} tokens=${String(r.spend.totalTokens)} appr=${String(r.approvals.requested)} CI ${r.checks.ci.green ? "green" : "RED"} accept ${r.checks.acceptance.passed ? "pass" : "fail"}`);
    },
    stopRequested: () => interrupted,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "the endpoint could not be reached");
    return process.exit(2);
  });
  if (has("fresh")) await removeDir(setDir);
  await mkdir(setDir, { recursive: true });
  console.log(`REAL RUNS: ${String(tickets.length)} tickets x ${String(runsPerTicket)} runs on model ${inputs.model.modelId} (set "${label}", ${String(concurrency)} at a time, API format ${options.modelInfo.format}). This spends tokens.`);
  console.log(`  per run: up to ${String(limits.timeoutMs / 60_000)} min and ${String(limits.maxTokens)} tokens${maxUsd === undefined ? " (no dollar cap: prices are not set, so spend is reported in tokens only; OSTRA_SPIKE_PRICE_INPUT and _OUTPUT)" : ` and $${String(maxUsd)}`}`);
  console.log(`  records go to ${setDir}; an interrupted set resumes where it stopped; the agent's task folders are under ${WORK_ROOT}\n`);
  const result = await runSet(options);
  console.log(`\n${formatRunTable(result.records)}`);
  console.log(`\n${String(result.reused.length)} runs were already recorded, ${String(result.retried.length)} redone (--retry-failed), ${String(result.failed.length)} failed to complete; ${String(await sweep(folders))} leftover processes killed`);
  const stillFailing = result.records.filter((r) => needsRetry(r)).length;
  if (stillFailing > 0) console.log(`${String(stillFailing)} recorded runs ended in an error or a crash, or hit model errors: they count as runs that were not mergeable until they are redone with --retry-failed`);
  console.log(`next: pnpm sheet --sets=${path.relative(SPIKE_ROOT, setDir)}   (then a reviewer rates it, then pnpm score)`);
  process.exitCode = result.failed.length === 0 ? 0 : 1;
}
await cleanWorkRoot();
