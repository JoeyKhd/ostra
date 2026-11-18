// `pnpm spike`: runs every pass-bar criterion it can and prints PASS, FAIL or SKIPPED for each.
//
//   SPIKE_ONLY=C1,C2 pnpm spike     run a subset (PowerShell: $env:SPIKE_ONLY="C1,C2"; pnpm spike)
//
// A criterion that needs an input this machine lacks is SKIPPED with the exact input named. A PASS
// is printed only for a scenario that actually ran and met its bar. The exit code is 0 only when
// every selected scenario is PASS: a run in which nothing executed is not green.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupStaleClusters, newRunId, prismaGenerate, startCluster } from "./cluster.ts";
import type { Cluster } from "./cluster.ts";
import { settingsSchema } from "./kit.ts";
import type { CriterionResult, RunContext, StaticContext } from "./kit.ts";
import { killTrackedSync, pidIsAlive } from "./proc.ts";
import * as o1 from "./observations.ts";
import * as c1 from "./scenarios/c1-transactional-enqueue.ts";
import * as c2 from "./scenarios/c2-kill-mid-job.ts";
import * as c3 from "./scenarios/c3-group-limit.ts";
import * as c4 from "./scenarios/c4-schedules.ts";
import * as c5 from "./scenarios/c5-delayed-jobs.ts";
import * as c6 from "./scenarios/c6-panel-no-workers.ts";
import * as c7 from "./scenarios/c7-strict-compile.ts";

type Scenario =
  | {
      readonly kind: "static";
      readonly id: string;
      readonly criterion: string;
      readonly run: (ctx: StaticContext) => Promise<CriterionResult>;
    }
  | {
      readonly kind: "cluster";
      readonly id: string;
      readonly criterion: string;
      readonly run: (ctx: RunContext) => Promise<CriterionResult>;
    };

const scenarios: readonly Scenario[] = [
  { kind: "static", id: c7.id, criterion: c7.criterion, run: c7.run },
  { kind: "cluster", id: c1.id, criterion: c1.criterion, run: c1.run },
  { kind: "cluster", id: c2.id, criterion: c2.criterion, run: c2.run },
  { kind: "cluster", id: c3.id, criterion: c3.criterion, run: c3.run },
  { kind: "cluster", id: c4.id, criterion: c4.criterion, run: c4.run },
  { kind: "cluster", id: c5.id, criterion: c5.criterion, run: c5.run },
  { kind: "cluster", id: c6.id, criterion: c6.criterion, run: c6.run },
];

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const settings = settingsSchema.parse(process.env);
const only = settings.SPIKE_ONLY?.split(",").map((part) => part.trim().toUpperCase());

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(projectRoot, ".runs", stamp);
const dataRoot = join(projectRoot, ".data");
const lockPath = join(dataRoot, "harness.pid");
/** A lock this old is a leftover of a run that was killed hard (and its PID may have been reused). */
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

const say = (line: string): void => {
  process.stdout.write(`${new Date().toISOString().slice(11, 23)} ${line}\n`);
};

let cluster: Cluster | undefined;
let lockHeld = false;

const releaseLock = async (): Promise<void> => {
  if (lockHeld) {
    lockHeld = false;
    await rm(lockPath, { force: true });
  }
};

/** Children and nothing else: the one sync call, because an `exit` handler cannot await. */
const killChildren = (): void => {
  // eslint-disable-next-line no-restricted-syntax -- sends SIGKILL to tracked children; an exit handler cannot await
  killTrackedSync();
};

/** Stops what is running and leaves, whatever state the run is in. Never rejects. */
const shutDown = async (code: number): Promise<void> => {
  killChildren();
  try {
    await cluster?.stop();
  } catch {
    // Nothing more to do: the stale-cluster cleanup of the next run removes a leftover data directory.
  }
  try {
    await releaseLock();
  } finally {
    process.exit(code);
  }
};

process.on("exit", killChildren);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    say(`received ${signal}: cleaning up`);
    shutDown(130).catch(() => undefined);
  });
}

const printResult = (result: CriterionResult): void => {
  process.stdout.write(`\n${result.verdict.padEnd(7)} ${result.id}  ${result.criterion}\n`);
  process.stdout.write(`        ${result.summary}\n`);
  if (result.qualifier !== undefined) {
    process.stdout.write(`        (${result.qualifier})\n`);
  }
  if (result.missingInput !== undefined) {
    process.stdout.write(`        needs: ${result.missingInput}\n`);
  }
  for (const line of result.evidence) {
    process.stdout.write(`        - ${line}\n`);
  }
};

/** One run at a time per directory: the stale-cluster cleanup would kill a live run's Postgres. */
const acquireLock = async (): Promise<boolean> => {
  await mkdir(dataRoot, { recursive: true });
  const raw = await readFile(lockPath, "utf8").catch(() => "");
  const [pidText, startedText] = raw.trim().split(" ");
  const previous = Number.parseInt(pidText ?? "", 10);
  const startedAt = Number.parseInt(startedText ?? "", 10);
  const fresh = Number.isInteger(startedAt) && Date.now() - startedAt < LOCK_STALE_MS;
  if (Number.isInteger(previous) && previous !== process.pid && pidIsAlive(previous) && fresh) {
    say(`another harness run (pid ${String(previous)}) is using this directory; not starting a second`);
    return false;
  }
  await writeFile(lockPath, `${String(process.pid)} ${String(Date.now())}`);
  lockHeld = true;
  return true;
};

const runSpike = async (): Promise<number> => {
  const selected = scenarios.filter((scenario) => only === undefined || only.includes(scenario.id));
  const results: CriterionResult[] = [];
  const known = [...scenarios.map((scenario) => scenario.id), o1.id];
  const unknown = (only ?? []).filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    say(`SPIKE_ONLY names no scenario called ${unknown.join(", ")}; known: ${known.join(", ")}`);
    return 2;
  }
  const wantsObservation = only === undefined || only.includes(o1.id);
  if (selected.length === 0 && !wantsObservation) {
    say("no scenario selected");
    return 2;
  }

  await mkdir(runDir, { recursive: true });
  say(`node ${process.version} on ${process.platform}; run directory ${runDir}`);

  // The replicas import the generated client, so it must exist before any scenario starts them.
  await prismaGenerate(projectRoot);
  const removed = await cleanupStaleClusters(dataRoot);
  if (removed > 0) {
    say(`removed ${String(removed)} stale Postgres data directories from an earlier run`);
  }

  const externalUrl = settings.SPIKE_DATABASE_URL;
  let cleanupProblem = false;
  if (selected.some((scenario) => scenario.kind === "cluster") || wantsObservation) {
    try {
      say(externalUrl === undefined ? "starting embedded-postgres" : "using SPIKE_DATABASE_URL as the Postgres server");
      cluster = await startCluster({
        projectRoot,
        dataRoot,
        externalUrl,
        runId: settings.SPIKE_RUN_ID ?? newRunId(),
        onLog: () => undefined,
      });
      say(`postgres ${cluster.version} ready (${cluster.kind})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      say(`could not start Postgres: ${reason}`);
    }
  }

  for (const scenario of selected) {
    if (scenario.kind === "cluster" && cluster === undefined) {
      results.push({
        id: scenario.id,
        criterion: scenario.criterion,
        verdict: "SKIPPED",
        summary: "No Postgres server could be started.",
        evidence: [],
        missingInput:
          "a Postgres server: embedded-postgres failed to start on this machine (on Windows, run `pnpm check:inputs`: a checkout path much longer than about 85 characters breaks postgres.exe), or set SPIKE_DATABASE_URL to one that allows CREATE and DROP DATABASE",
      });
      continue;
    }
    say(`running ${scenario.id}`);
    const started = Date.now();
    const base: StaticContext = {
      projectRoot,
      runDir,
      settings,
      note: (message) => {
        say(`[${scenario.id.toLowerCase()}] ${message}`);
      },
    };
    try {
      if (scenario.kind === "static") {
        results.push(await scenario.run(base));
      } else if (cluster !== undefined) {
        results.push(await scenario.run({ ...base, cluster }));
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      results.push({
        id: scenario.id,
        criterion: scenario.criterion,
        verdict: "FAIL",
        summary: `The scenario stopped before it could judge: ${reason}`,
        evidence: [],
      });
    }
    say(`${scenario.id} finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    // Flush as we go: a crash later must not lose what already ran.
    await writeFile(join(runDir, "results.json"), `${JSON.stringify({ results, observations: [] }, null, 2)}\n`);
  }

  const observations: { readonly id: string; readonly title: string; readonly lines: readonly string[] }[] = [];
  if (cluster !== undefined && wantsObservation) {
    try {
      const lines = await o1.run({
        projectRoot,
        runDir,
        settings,
        cluster,
        note: (message) => {
          say(`[o1] ${message}`);
        },
      });
      observations.push({ id: o1.id, title: o1.title, lines });
    } catch (error) {
      observations.push({
        id: o1.id,
        title: o1.title,
        lines: [`probe failed: ${error instanceof Error ? error.message : "unknown"}`],
      });
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  process.stdout.write("\n==================== results ====================\n");
  for (const result of results) {
    printResult(result);
  }
  if (observations.length > 0) {
    process.stdout.write("\n==================== observations (not criteria) ====================\n");
    for (const observation of observations) {
      process.stdout.write(`\n${observation.id}  ${observation.title}\n`);
      for (const line of observation.lines) {
        process.stdout.write(`        - ${line}\n`);
      }
    }
  }
  process.stdout.write("\n==================== summary ====================\n");
  for (const result of results) {
    const qualifier = result.qualifier === undefined ? "" : ` (${result.qualifier})`;
    process.stdout.write(`${`${result.verdict}${qualifier}`.padEnd(7)} ${result.id}  ${result.criterion}\n`);
  }
  await writeFile(join(runDir, "results.json"), `${JSON.stringify({ results, observations }, null, 2)}\n`);

  // Postgres stops after the results are out: a stubborn Windows file lock must never swallow them.
  // The cluster drops every database it created first (it matters on a shared server).
  if (cluster !== undefined) {
    const stopping = cluster;
    cluster = undefined;
    try {
      const left = await stopping.stop();
      if (left.length > 0) {
        cleanupProblem = true;
        say(`could not drop ${String(left.length)} database(s) this run created: ${left.join(", ")}`);
      }
    } catch (error) {
      cleanupProblem = true;
      say(`postgres did not stop cleanly: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  const green = results.every((result) => result.verdict === "PASS") && !cleanupProblem;
  if (settings.SPIKE_KEEP_LOGS === undefined && green) {
    // Logs of a green run are not needed; a red or skipped one keeps them.
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  } else {
    process.stdout.write(`\nlogs and results: ${runDir}\n`);
  }
  // Only PASS is green. A SKIPPED scenario is not a pass: a run in which nothing executed is not either.
  return green ? 0 : 1;
};

const main = async (): Promise<number> => {
  if (!(await acquireLock())) {
    return 2;
  }
  try {
    return await runSpike();
  } finally {
    await releaseLock();
  }
};

main()
  .then((code) => {
    process.exitCode = code;
    // Everything is closed by now. If a handle was left open anyway, the process still leaves, so a
    // failed start can never hang a gate script. The timer is unref'd: it does not hold the loop itself.
    setTimeout(() => process.exit(code), 5_000).unref();
  })
  .catch((error: unknown) => {
    process.stderr.write(`harness crashed: ${error instanceof Error ? (error.stack ?? error.message) : "unknown"}\n`);
    shutDown(2).catch(() => undefined);
  });
