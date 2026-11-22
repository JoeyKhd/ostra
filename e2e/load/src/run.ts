// `pnpm load:run --tasks N` or `pnpm load:run --ramp [100,250,500,1000]` (ticket 34, F-117, ADR 0061).
//
// Each step starts its own stack (one Postgres, three core replicas, and one panel when browsers
// watch), joins simulated runners to a pool through `packages/api` and a join token, starts N
// prompt tasks through `packages/api`, lets the real queue admit them and the real dispatcher hand
// them out, and then, for the measured window: times steers from the API's call to the runner's
// receipt, samples Postgres's CPU, reads each replica's ingest time and memory, and times partial
// text into real browsers. After the window every runner's connection is cut at once (the
// reconnect storm) and steers are sent again, then the runners drain and every offered event is
// checked as stored exactly once. Results go to `.data/load/<time>/results.json`, and the summary
// names the largest step that held every bar and how the next one failed.
//
// Options: --replicas 3, --slots 1 (a runner's slots), --per-process 250 (tasks a generator
// process), --browsers 5, --warmup 15, --window 60 (seconds), --steers 200, --transport websocket,
// --out <dir>. Ports: OSTRA_CORE_PORT (and the next ones), OSTRA_WEB_PORT, OSTRA_DEV_PG_PORT.
// DATABASE_URL: a Postgres of your own instead of the embedded one (its CPU is then not sampled
// unless --pg-pid names its postmaster).

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { silentLogger } from "@ostra/adapter-sdk";
import { repoRoot } from "@ostra/db/dev";
import { parseServerSettings } from "@ostra/domain";
import { clientMessageIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { z } from "zod";

import { startHarnessApi } from "./api.ts";
import type { HarnessApi } from "./api.ts";
import { openBrowsers } from "./browsers.ts";
import type { BrowserWatch } from "./browsers.ts";
import type { GeneratorLine } from "./generator-protocol.ts";
import { generatorShares, startGenerator } from "./generators.ts";
import type { GeneratorProcess } from "./generators.ts";
import { partialTextOn } from "./mix.ts";
import { startNetCut } from "./net-cut.ts";
import type { NetCut } from "./net-cut.ts";
import { cpuCores, sampleProcess, startSampling } from "./process-sampler.ts";
import { seedLoadWorld } from "./seed.ts";
import { startStack } from "./stack.ts";
import type { Stack } from "./stack.ts";
import { bucketPercentile, createSteerTimer, summarize } from "./stats.ts";
import { judgeRun, judgeStep, summaryMarkdown } from "./verdict.ts";
import type { RunResults, StepResult } from "./verdict.ts";

const say = (line: string): void => {
  process.stdout.write(`[load] ${line}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const positive = z.coerce.number().int().positive();

const optionsSchema = z.strictObject({
  tasks: positive.optional(),
  ramp: z
    .string()
    .transform((text) => text.split(",").map((part) => Number(part.trim())))
    .pipe(z.array(z.number().int().positive()).min(1))
    .optional(),
  replicas: positive.default(3),
  slots: positive.default(1),
  "per-process": positive.default(250),
  browsers: z.coerce.number().int().nonnegative().default(5),
  warmup: z.coerce.number().nonnegative().default(15),
  window: z.coerce.number().positive().default(60),
  steers: positive.default(200),
  transport: z.enum(["websocket", "http", "auto"]).default("websocket"),
  out: z.string().optional(),
  "pg-pid": positive.optional(),
});
type Options = z.infer<typeof optionsSchema>;

const parseArgs = (argv: readonly string[]): Options => {
  const raw: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=", 2);
    if (name === undefined) continue;
    const following = argv[index + 1];
    if (inline !== undefined) raw[name] = inline;
    else if (following !== undefined && !following.startsWith("--")) {
      raw[name] = following;
      index += 1;
    } else raw[name] = name === "ramp" ? "100,250,500,1000" : "true";
  }
  return optionsSchema.parse(raw);
};

const portOf = (name: string, fallback: number): number => {
  const parsed = positive.safeParse(process.env[name]);
  return parsed.success ? parsed.data : fallback;
};

const ADMIN = { email: "load-admin@example.com", password: `load-${randomUUID()}` } as const;

/** Runs `work` over `items`, at most `concurrency` at once. */
const eachLimited = async <T,>(items: readonly T[], concurrency: number, work: (item: T, index: number) => Promise<void>): Promise<void> => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item !== undefined) await work(item, index);
      }
    }),
  );
};

const waitUntil = async (what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(250);
  }
  say(`gave up waiting for ${what}`);
  return false;
};

const machine = (): string => {
  const cpus = os.cpus();
  return `${os.type()} ${os.release()} (${process.platform}/${process.arch}), ${cpus[0]?.model.trim() ?? "unknown CPU"}, ${String(cpus.length)} logical CPUs, ${String(Math.round(os.totalmem() / 1024 ** 3))} GB, Node ${process.version}`;
};

const emptyResult = (tasks: number, options: Options, startedAt: string, error: string): StepResult => ({
  tasks,
  replicas: options.replicas,
  generators: Math.ceil(tasks / options["per-process"]),
  runners: Math.ceil(tasks / options.slots),
  startedAt,
  windowSeconds: 0,
  dispatched: 0,
  steer: { sent: 0, received: 0, lost: 0, latencyMs: summarize([]) },
  events: { offered: 0, stored: 0, duplicates: 0, missing: 0, perTaskPerMinute: 0 },
  ackMs: summarize([]),
  ingestMs: { frames: 0, p50: null, p99: null, max: null },
  postgres: { samples: 0, meanCores: null, maxCores: null, source: "not sampled" },
  replicaMemoryMiB: [],
  storm: null,
  browsers: null,
  error,
});

const ingestBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const;
const ingestLineSchema = z.looseObject({ msg: z.literal("ingest.timing"), frames: z.number(), maxMs: z.number(), buckets: z.array(z.number()) });

const runStep = async (tasks: number, options: Options, runDir: string): Promise<StepResult> => {
  const startedAt = new Date().toISOString();
  const dir = path.join(runDir, `step-${String(tasks)}`);
  await mkdir(dir, { recursive: true });
  const corePort = portOf("OSTRA_CORE_PORT", 9520);
  const webPort = options.browsers > 0 ? portOf("OSTRA_WEB_PORT", 3920) : null;
  const pgPort = portOf("OSTRA_DEV_PG_PORT", 55120);
  say(`step ${String(tasks)}: starting the stack`);
  let stack: Stack;
  try {
    stack = await startStack({ dir, replicas: options.replicas, corePort, webPort, pgPort, databaseUrl: process.env["DATABASE_URL"], admin: ADMIN, say });
  } catch (error) {
    return emptyResult(tasks, options, startedAt, error instanceof Error ? error.message : "the stack didn't start");
  }
  const cuts: NetCut[] = [];
  const generators: GeneratorProcess[] = [];
  let api: HarnessApi | undefined;
  let browsers: BrowserWatch | undefined;
  let watched: readonly TaskId[] = [];
  try {
    const parsed = parseServerSettings(stack.serverEnv);
    if (!parsed.ok) throw new Error(`the stack's settings are invalid: ${parsed.errors.join("; ")}`);
    api = await startHarnessApi({ settings: parsed.settings, secretsKey: stack.secretsKey, adminEmail: ADMIN.email, adminPassword: ADMIN.password, logger: silentLogger });
    const world = await seedLoadWorld(api.db);
    for (const core of stack.cores) cuts.push(await startNetCut(core.port));

    // The pool, through the API: approval required, so each runner is approved as an admin would.
    const pool = await api.admin.pools.create({ name: `load-${String(tasks)}`, requiresApproval: true, projectIds: [world.projectId] });
    const runnerCount = Math.ceil(tasks / options.slots);
    // The window's steers are timed against the bar; the ones after the storm are counted, not timed,
    // since they wait for runners that are still coming back.
    const steers = createSteerTimer();
    const stormSteers = createSteerTimer();
    const dispatched = new Map<string, { generator: number; partialText: boolean; at: number }>();
    const marked = new Map<string, number>();
    const errors: string[] = [];
    const runnerData = path.join(os.tmpdir(), `ostra-load-${String(process.pid)}-${String(tasks)}`);
    for (const [index, runners] of generatorShares(tasks, options.slots, options["per-process"]).entries()) {
      const generator = startGenerator(
        index,
        {
          serverUrls: cuts.map((cut) => cut.url),
          joinToken: pool.joinToken.token,
          prefix: `g${String(index + 1)}`,
          runners,
          slots: options.slots,
          dataDir: path.join(runnerData, `g${String(index + 1)}`),
          transport: options.transport,
          registerConcurrency: 8,
        },
        dir,
      );
      generator.onLine((line: GeneratorLine) => {
        switch (line.t) {
          case "dispatched":
            dispatched.set(line.taskId, { generator: index, partialText: line.partialText, at: Date.now() });
            return;
          case "steer":
            steers.received(line.id, line.at);
            stormSteers.received(line.id, line.at);
            return;
          case "marked":
            if (line.at !== null) marked.set(line.marker, line.at);
            return;
          case "error":
            if (errors.length < 20) errors.push(line.message);
            return;
          case "registered":
          case "report":
          case "acks":
          case "drained":
            return;
          default:
            line satisfies never;
        }
      });
      generators.push(generator);
    }

    say(`step ${String(tasks)}: joining ${String(runnerCount)} runners in ${String(generators.length)} generator processes`);
    const registered = await Promise.all(generators.map((generator) => generator.next("registered", 600_000)));
    const runnerIds = registered.flatMap((line) => line.runners.map((runner) => runnerIdSchema.parse(runner.runnerId)));
    await eachLimited(runnerIds, 8, async (runnerId) => {
      await api?.admin.runners.approve({ runnerId });
    });
    for (const generator of generators) generator.send({ cmd: "connect" });
    const report = async (): Promise<{ connected: number; runners: number }> => {
      const lines = await Promise.all(
        generators.map((generator) => {
          const waiting = generator.next("report", 60_000);
          generator.send({ cmd: "report" });
          return waiting;
        }),
      );
      return { connected: lines.reduce((sum, line) => sum + line.connected, 0), runners: lines.reduce((sum, line) => sum + line.runners, 0) };
    };
    await waitUntil("every runner to connect", async () => (await report()).connected >= runnerCount, 300_000);

    say(`step ${String(tasks)}: starting ${String(tasks)} tasks through the API`);
    const taskIds: TaskId[] = [];
    await eachLimited(
      Array.from({ length: tasks }, (_unused, index) => index),
      16,
      async (index) => {
        const created = await api?.admin.tasks.create({ projectId: world.projectId, prompt: `Load task ${String(index + 1)}: read the store and keep the cursor` });
        if (created !== undefined) taskIds.push(taskIdSchema.parse(created.taskId));
      },
    );
    await waitUntil("every task's dispatch", () => taskIds.every((taskId) => dispatched.has(taskId)), 120_000 + tasks * 300);
    const dispatchedCount = taskIds.filter((taskId) => dispatched.has(taskId)).length;
    say(`step ${String(tasks)}: ${String(dispatchedCount)} of ${String(tasks)} tasks dispatched`);

    if (stack.webUrl !== null && options.browsers > 0) {
      watched = taskIds.filter((taskId) => dispatched.has(taskId) && partialTextOn(taskId)).slice(0, options.browsers);
      say(`step ${String(tasks)}: opening ${String(watched.length)} browsers on tasks with partial text`);
      browsers = await openBrowsers({ webUrl: stack.webUrl, admin: ADMIN, taskIds: watched }).catch((error: unknown) => {
        say(`the browsers didn't open: ${error instanceof Error ? error.message : "unknown"}`);
        return undefined;
      });
    }

    await sleep(options.warmup * 1000);

    // ---- the measured window ----
    say(`step ${String(tasks)}: measuring for ${String(options.window)} s`);
    await Promise.all(
      generators.map((generator) => {
        const waiting = generator.next("acks", 60_000);
        generator.send({ cmd: "acks" });
        return waiting;
      }),
    );
    const ingest = { frames: 0, maxMs: 0, buckets: Array.from({ length: ingestBuckets.length + 1 }, () => 0) };
    let collecting = true;
    stack.onCoreLine((line) => {
      if (!collecting) return;
      const parsedLine = ingestLineSchema.safeParse(line);
      if (!parsedLine.success) return;
      ingest.frames += parsedLine.data.frames;
      ingest.maxMs = Math.max(ingest.maxMs, parsedLine.data.maxMs);
      for (const [index, count] of parsedLine.data.buckets.entries()) ingest.buckets[index] = (ingest.buckets[index] ?? 0) + count;
    });
    const pgPid = options["pg-pid"] ?? stack.pgPid;
    const pgSampling = pgPid === null ? null : startSampling(pgPid, 5_000);
    const windowStart = Date.now();
    const live = taskIds.filter((taskId) => dispatched.has(taskId));
    const steerGap = (options.window * 1000) / Math.max(1, options.steers);
    const inflight: Promise<void>[] = [];
    let markCount = 0;
    const markTimer =
      browsers === undefined
        ? undefined
        : setInterval(() => {
            for (const taskId of watched) {
              const generator = generators[dispatched.get(taskId)?.generator ?? -1];
              markCount += 1;
              generator?.send({ cmd: "mark", taskId, marker: `mk-s${String(tasks)}-${String(markCount)}` });
            }
          }, 2_000);
    const sendSteer = (taskId: TaskId, timer = steers): Promise<void> => {
      const clientMessageId = clientMessageIdSchema.parse(randomUUID());
      timer.sent(clientMessageId, Date.now());
      return (api?.admin.tasks.send({ taskId, clientMessageId, text: "Keep the cursor where it was" }) ?? Promise.resolve())
        .then(() => undefined)
        .catch((error: unknown) => {
          if (errors.length < 20) errors.push(`a steer's call failed: ${error instanceof Error ? error.message : "unknown"}`);
        });
    };
    for (let index = 0; index < options.steers && live.length > 0; index += 1) {
      const due = windowStart + index * steerGap;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const taskId = live[Math.floor(Math.random() * live.length)];
      if (taskId !== undefined) inflight.push(sendSteer(taskId));
    }
    const remaining = windowStart + options.window * 1000 - Date.now();
    if (remaining > 0) await sleep(remaining);
    if (markTimer !== undefined) clearInterval(markTimer);
    const windowSeconds = (Date.now() - windowStart) / 1000;
    await Promise.all(inflight);
    const acks = await Promise.all(
      generators.map((generator) => {
        const waiting = generator.next("acks", 60_000);
        generator.send({ cmd: "acks" });
        return waiting;
      }),
    );
    const pgSamples = pgSampling === null ? [] : await pgSampling.stop();
    // The last `ingest.timing` lines of the window come up to 10 s after it.
    await sleep(10_500);
    collecting = false;
    const memory = await Promise.all(stack.cores.map((core) => sampleProcess(core.pid).then((sample) => sample.rssBytes / 1024 ** 2, () => null)));
    await sleep(3_000);
    const browserResult =
      browsers === undefined
        ? null
        : (() => {
            const latencies: number[] = [];
            for (const [marker, at] of marked) {
              const seenAt = browsers.seen.get(marker);
              if (seenAt !== undefined) latencies.push(seenAt - at);
            }
            return { pages: browsers.pages, marks: marked.size, seen: latencies.length, latencyMs: summarize(latencies) };
          })();

    // ---- the reconnect storm ----
    say(`step ${String(tasks)}: the reconnect storm`);
    const stormStart = Date.now();
    let cutCount = 0;
    for (const cut of cuts) cutCount += cut.cut();
    say(`step ${String(tasks)}: cut ${String(cutCount)} connections`);
    await sleep(500);
    const back = await waitUntil("every runner back after the storm", async () => (await report()).connected >= runnerCount, 300_000);
    const stormSeconds = back ? (Date.now() - stormStart) / 1000 : null;
    const reconnected = (await report()).connected;
    // Steers after the storm: none may be lost.
    await Promise.all(live.slice(0, Math.min(20, live.length)).map((taskId) => sendSteer(taskId, stormSteers)));
    await waitUntil("every steer", () => steers.result().lost.length === 0 && stormSteers.result().lost.length === 0, 60_000);

    // ---- drain, then check every event stored exactly once ----
    say(`step ${String(tasks)}: draining`);
    const drained = await Promise.all(
      generators.map((generator) => {
        const waiting = generator.next("drained", 300_000);
        generator.send({ cmd: "drain" });
        return waiting;
      }),
    );
    const sessions = drained.flatMap((line) => line.sessions);
    const offered = sessions.reduce((sum, session) => sum + session.offered, 0);
    const counted = z
      .array(z.object({ sessionId: z.string(), rows: z.coerce.number(), distinctSeqs: z.coerce.number() }))
      .parse(
        await api.db.$queryRaw`SELECT "sessionId", count(*) AS rows, count(DISTINCT "sessionSeq") AS "distinctSeqs" FROM "event" WHERE "sessionSeq" IS NOT NULL GROUP BY "sessionId"`,
      );
    const bySession = new Map(counted.map((row) => [row.sessionId, row]));
    let stored = 0;
    let duplicates = 0;
    let missing = 0;
    for (const session of sessions) {
      const row = bySession.get(session.sessionId);
      const distinct = row?.distinctSeqs ?? 0;
      stored += Math.min(distinct, session.offered);
      duplicates += (row?.rows ?? 0) - distinct;
      missing += Math.max(0, session.offered - distinct);
    }
    const firstDispatch = Math.min(...[...dispatched.values()].map((item) => item.at));
    const emittingMinutes = Math.max(1 / 60, (Date.now() - firstDispatch) / 60_000);
    const steer = steers.result();
    const afterStorm = stormSteers.result();
    if (errors.length > 0) say(`step ${String(tasks)}: generator errors: ${errors.slice(0, 5).join(" | ")}`);
    const pgCores = pgSamples.slice(1).map((sample, index) => {
      const before = pgSamples[index];
      return before === undefined ? 0 : cpuCores(before, sample);
    });

    return {
      tasks,
      replicas: options.replicas,
      generators: generators.length,
      runners: runnerCount,
      startedAt,
      windowSeconds,
      dispatched: dispatchedCount,
      steer: { sent: steer.sent + afterStorm.sent, received: steer.received + afterStorm.received, lost: steer.lost.length + afterStorm.lost.length, latencyMs: steer.latencyMs },
      events: { offered, stored, duplicates, missing, perTaskPerMinute: offered / Math.max(1, sessions.length) / emittingMinutes },
      ackMs: summarize(acks.flatMap((line) => line.ackMs)),
      ingestMs: {
        frames: ingest.frames,
        p50: bucketPercentile(ingestBuckets, ingest.buckets, 50),
        p99: bucketPercentile(ingestBuckets, ingest.buckets, 99),
        max: ingest.frames === 0 ? null : ingest.maxMs,
      },
      postgres: {
        samples: pgSamples.length,
        meanCores: pgCores.length === 0 ? null : pgCores.reduce((sum, value) => sum + value, 0) / pgCores.length,
        maxCores: pgCores.length === 0 ? null : Math.max(...pgCores),
        source: pgPid === null ? "not sampled: Postgres isn't the harness's" : `${process.platform === "linux" ? "/proc" : process.platform === "win32" ? "Win32_Process counters" : "ps"}, the postmaster and its backends, every 5 s`,
      },
      replicaMemoryMiB: memory,
      storm: { runners: runnerCount, reconnected, seconds: stormSeconds },
      browsers: browserResult,
      error: stack.failure(),
    };
  } catch (error) {
    return emptyResult(tasks, options, startedAt, error instanceof Error ? error.message : "the step failed");
  } finally {
    await browsers?.close().catch(() => undefined);
    await Promise.all(generators.map((generator) => generator.stop()));
    for (const cut of cuts) await cut.close();
    await api?.close().catch(() => undefined);
    await stack.stop();
    await rm(path.join(os.tmpdir(), `ostra-load-${String(process.pid)}-${String(tasks)}`), { recursive: true, force: true }).catch(() => undefined);
  }
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const steps = options.ramp ?? (options.tasks === undefined ? null : [options.tasks]);
  if (steps === null) {
    process.stderr.write("Usage: pnpm load:run --tasks N | --ramp [100,250,500,1000] [--replicas 3] [--slots 1] [--per-process 250] [--browsers 5] [--window 60]\n");
    process.exit(2);
  }
  const runDir = options.out ?? path.join(repoRoot, ".data", "load", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(runDir, { recursive: true });
  const results: RunResults = { machine: machine(), steps: [] };
  say(`results in ${runDir}`);
  for (const tasks of steps) {
    const result = await runStep(tasks, options, runDir);
    results.steps.push(result);
    await writeFile(path.join(runDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
    const verdict = judgeStep(result);
    say(`step ${String(tasks)}: ${verdict.held ? "held" : `failed: ${verdict.failures.join("; ")}`}`);
    // A ramp stops at its first failed step: the next is larger, and the record is what held.
    if (!verdict.held && options.ramp !== undefined) break;
  }
  const summary = `# Load test\n\n${results.machine}\n\n${summaryMarkdown(results)}`;
  await writeFile(path.join(runDir, "summary.md"), summary);
  process.stdout.write(`\n${summary}\n`);
  process.exit(judgeRun(results.steps).next === null ? 0 : 1);
};

await main();
