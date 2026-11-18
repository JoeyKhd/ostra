// `pnpm spike`: runs every pass-bar criterion of spike 6 that this machine can,
// and prints PASS, FAIL or SKIPPED for each, with the bar's own bullets.
//
//   pnpm spike                 real timings (about 13 minutes: the 11-minute cut runs in parallel)
//   pnpm spike --quick         timers divided by 20, for development; the timing bars are then SKIPPED
//   pnpm spike --only=networks,versions
//   pnpm spike --full-load     2,000 connections and 1,000 sessions (meant for the Linux machine)

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseArgs, boolArg } from "../shared/args.ts";
import { makeCerts } from "./certs.ts";
import { startReplica, type Ctx, type Replica } from "./cluster.ts";
import { tcpProxy } from "./net-proxies.ts";
import { startDb } from "./postgres.ts";
import { killAll, setLogDir } from "./procs.ts";
import { guarded, overall, skipped, type Check, type Verdict } from "./report.ts";
import { lostAcks } from "./scenarios/acks.ts";
import { crossRunnerAck } from "./scenarios/authz.ts";
import { cuts } from "./scenarios/cuts.ts";
import { kill9 } from "./scenarios/kill9.ts";
import { load } from "./scenarios/load.ts";
import { networks } from "./scenarios/networks.ts";
import { sleepThrough } from "./scenarios/sleep.ts";
import { steerLatency } from "./scenarios/steer.ts";
import { versions } from "./scenarios/versions.ts";

const SCENARIOS = ["networks", "kill9", "acks", "authz", "cuts", "steer", "load", "versions", "sleep"] as const;
type Scenario = (typeof SCENARIOS)[number];

const args = parseArgs(
  z.object({
    quick: boolArg.default(false),
    only: z.string().optional(),
    "full-load": boolArg.default(false),
  }),
);
const only = new Set<Scenario>(
  args.only === undefined ? SCENARIOS : z.array(z.enum(SCENARIOS)).parse(args.only.split(",").filter((s) => s.length > 0)),
);
const timeScale = args.quick ? 20 : 1;

const BULLETS = {
  networks: "Through a CONNECT proxy, a TLS-inspecting proxy and nginx's defaults, the runner connects, or falls back to HTTP by itself within 30 s.",
  loss: "After `kill -9`, and after network cuts of 30 s, 5 min and 11 min, every event is stored exactly once. After 11 min the task stops cleanly and stale writes are refused.",
  steer: "With two core replicas, a steer reaches the runner in under 500 ms at p99, and in under 2.5 s with notifications off.",
  load: "One replica holds 2,000 connections. Three replicas and one Postgres carry 1,000 sessions at the event rates spike 1 recorded.",
  versions: "A runner one minor older or newer works, or is refused with a clear message.",
  sleep: "A laptop that sleeps through the grace period can't write afterwards.",
} as const;

type CriterionOut = { bullet: string; verdict: Verdict; checks: Check[]; caveat?: string };

const print = (c: CriterionOut): void => {
  process.stdout.write(`\n${c.verdict.label.padEnd(7)} ${c.bullet}\n`);
  if (c.caveat !== undefined) process.stdout.write(`        caveat: ${c.caveat}\n`);
  for (const k of c.checks) process.stdout.write(`        ${k.result.padEnd(7)} ${k.name}: ${k.note}\n`);
};

/** Private keys and the Postgres data directory don't outlive the run; logs and results.json do. */
const scrub = async (dataDir: string): Promise<void> => {
  await rm(path.join(dataDir, "certs"), { recursive: true, force: true }).catch(() => undefined);
  await rm(path.join(dataDir, "pg"), { recursive: true, force: true }).catch(() => undefined);
};

let currentDataDir: string | undefined;

const main = async (): Promise<number> => {
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.resolve(import.meta.dirname, "..", "..");
  const dataDir = path.join(root, ".data", `run-${runId}`);
  currentDataDir = dataDir;
  await mkdir(path.join(dataDir, "logs"), { recursive: true });
  setLogDir(path.join(dataDir, "logs"));
  process.stdout.write(`spike 6 (runner-transport) on ${process.platform} ${process.arch}, Node ${process.version}${args.quick ? ", QUICK (timers / 20)" : ""}\n`);
  process.stdout.write(`logs: ${path.join(dataDir, "logs")}\n`);

  const certs = await makeCerts(path.join(dataDir, "certs"));
  const db = await startDb(path.join(dataDir, "pg"));
  process.stdout.write(`postgres: ${db.embedded ? "embedded-postgres on this machine" : "SPIKE_DATABASE_URL"} (schema spike_runner_transport)\n`);
  const ctx: Ctx = {
    root,
    dataDir,
    db: db.pool,
    dbUrl: db.url,
    certs,
    serverCaPem: await readFile(certs.serverCa, "utf8"),
    secret: randomBytes(24).toString("hex"),
    metricsToken: randomBytes(24).toString("hex"),
    timeScale,
  };

  try {
    // Two replicas for the short scenarios, two more for the long ones, so a
    // kill -9 in one never disturbs a cut being timed in the other.
    const needShort = only.has("networks") || only.has("kill9") || only.has("steer") || only.has("versions") || only.has("authz");
    const needLong = only.has("cuts") || only.has("sleep");
    const short: Replica[] = needShort ? [await startReplica(ctx, "a"), await startReplica(ctx, "b")] : [];
    const long: Replica[] = needLong ? [await startReplica(ctx, "c"), await startReplica(ctx, "d")] : [];
    const shortLb = await tcpProxy(() => short.map((r) => ({ host: "127.0.0.1", port: r.port })));

    // The long scenarios start first and run beside the short ones.
    const longRuns: Promise<{ cuts: Check[]; sleep: Check[] }> = Promise.all([
      only.has("cuts") ? guarded("cuts", () => cuts(ctx, long)) : Promise.resolve([]),
      only.has("sleep") ? guarded("sleep", () => sleepThrough(ctx, long)) : Promise.resolve([]),
    ]).then(([c, s]) => ({ cuts: c, sleep: s }));

    const net = only.has("networks") ? await guarded("networks", () => networks(ctx, shortLb, "n")) : [];
    const ver = only.has("versions") ? await guarded("versions", () => versions(ctx, short)) : [];
    const k9 = only.has("kill9") ? await guarded("kill9", () => kill9(ctx, short)) : [];
    const ac = only.has("acks") ? await guarded("acks", () => lostAcks(ctx)) : [];
    const az = only.has("authz") ? await guarded("authz", () => crossRunnerAck(ctx, short)) : [];
    const st = only.has("steer") ? await guarded("steer", () => steerLatency(ctx, short)) : [];
    for (const r of short) await r.child.kill9();
    const ld = only.has("load") ? await guarded("load", () => load(ctx, args["full-load"])) : [];
    process.stdout.write("\nwaiting for the long scenarios (cuts, sleep)...\n");
    const lr = await longRuns;
    await shortLb.close();

    const notRun = (name: string): Check[] => [skipped(name, "not selected with --only")];
    const platforms = new Set<string>([process.platform]);
    const crit: CriterionOut[] = [
      { bullet: BULLETS.networks, checks: only.has("networks") ? net : notRun("networks") },
      {
        bullet: BULLETS.loss,
        checks: [
          ...(only.has("kill9") ? k9 : notRun("kill9")),
          ...(only.has("acks") ? ac : notRun("acks")),
          ...(only.has("cuts") ? lr.cuts : notRun("cuts")),
          ...(only.has("authz") ? az : []),
        ],
      },
      { bullet: BULLETS.steer, checks: only.has("steer") ? st : notRun("steer") },
      { bullet: BULLETS.load, checks: only.has("load") ? ld : notRun("load") },
      {
        bullet: BULLETS.versions,
        checks: only.has("versions") ? ver : notRun("versions"),
        caveat: "the older and newer minors are simulated: the same runner build is started with --minor=1 and --minor=3. A runner built one minor apart hasn't run.",
      },
      { bullet: BULLETS.sleep, checks: only.has("sleep") ? lr.sleep : notRun("sleep") },
    ].map((c) => ({ ...c, verdict: overall(c.checks, platforms) }));

    process.stdout.write(`\n=== spike 6: runner-transport — results (${process.platform}; the bar asks for Windows, macOS and Linux) ===\n`);
    for (const c of crit) print(c);
    await writeFile(
      path.join(dataDir, "results.json"),
      JSON.stringify({ runId, platform: process.platform, node: process.version, quick: args.quick, criteria: crit }, null, 2),
    );
    process.stdout.write(`\nresults: ${path.join(dataDir, "results.json")}\n`);
    return crit.some((c) => c.verdict.result === "FAIL") ? 1 : 0;
  } finally {
    await killAll();
    await db.stop();
    await scrub(dataDir);
  }
};

const shutdown = (): void => {
  void killAll()
    .then(() => (currentDataDir === undefined ? undefined : scrub(currentDataDir)))
    .then(() => process.exit(130));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`harness failed: ${err instanceof Error ? (err.stack ?? err.message) : "unknown"}\n`);
    await killAll();
    if (currentDataDir !== undefined) await scrub(currentDataDir);
    process.exitCode = 2;
  });
