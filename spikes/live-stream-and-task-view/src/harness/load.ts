import { z } from "zod";
import { createRunnerClient, type RunnerClient } from "../producer/runner-client.ts";
import { createLoadScript, type LoadScript } from "../producer/scenarios.ts";
import { rows, type Db } from "../server/db.ts";
import { seedTasks } from "../server/seed.ts";
import { TaskId } from "../shared/ids.ts";
import { sleep } from "../shared/time.ts";
import { login, newRunnerToken, readMetrics } from "./context.ts";
import { databaseCpuSeconds, killTree, spawnNode, startServerProc, withTimeout, type ServerProc } from "./infra.ts";
import { fail, skipped, verdict, type Criterion } from "./report.ts";
import { percentile } from "./stats.ts";

const BAR = "5,000 events a second sustained and a burst of 10,000, at p99 under 500 ms from runner to browser, with Postgres under 50% of 4 vCPU.";

// The load is shaped like real sessions, not like a stream of one-liners: every `streamEvery`-th task streams
// partial text (the runner sends the open segment's whole text every 250 ms, and the server upserts it into the
// UNLOGGED table on every flush, ADR 0035), and every `largeOutputEvery`-th command completes with 4 to 20 KB of
// output.
export type LoadOptions = {
  readonly rate: number; // events per second, sustained
  readonly burst: number; // events in the burst second
  readonly durationSec: number; // the sustained phase, with partial text
  readonly baselineSec: number; // the same rate without partial text, to see what the UNLOGGED table costs
  readonly tasks: number;
  readonly viewersPerTask: number;
  readonly replicas: number;
  readonly runners: number;
  readonly batchMs: number;
  readonly streamEvery: number;
  readonly largeOutputEvery: number;
};

export const scaledOptions: LoadOptions = {
  rate: 1000,
  burst: 2000,
  durationSec: 20,
  baselineSec: 10,
  tasks: 100,
  viewersPerTask: 2,
  replicas: 2,
  runners: 4,
  batchMs: 20,
  streamEvery: 4,
  largeOutputEvery: 10,
};

export const fullOptions: LoadOptions = {
  rate: 5000,
  burst: 10_000,
  durationSec: 30,
  baselineSec: 15,
  tasks: 1000,
  viewersPerTask: 1,
  replicas: 3,
  runners: 10,
  batchMs: 20,
  streamEvery: 4,
  largeOutputEvery: 10,
};

const LIVE_STEP_CHARS = 256;
const LIVE_SEGMENT_CHARS = 4096;

export type LoadDatabase = { readonly url: string; readonly postmasterPid: number; readonly pool: Db };

export type PhaseStats = {
  readonly events: number;
  readonly deliveries: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
};

// Counters summed over every replica, read at the edges of a phase.
type Totals = { readonly events: number; readonly liveUpserts: number; readonly liveBytes: number; readonly payloadBytes: number };

export type LoadResult = {
  readonly options: LoadOptions;
  readonly sent: number;
  readonly stored: number;
  readonly viewersOpen: number;
  readonly viewersWanted: number;
  readonly delivered: number;
  readonly expectedDeliveries: number;
  readonly liveFramesDelivered: number;
  readonly streamingTasks: number;
  readonly gaps: number;
  readonly duplicates: number;
  readonly lossy: number;
  // events only, no partial text
  readonly baseline: PhaseStats;
  // with partial text: this is the sustained phase that is judged
  readonly sustained: PhaseStats;
  readonly burst: PhaseStats;
  readonly achievedBaselineRate: number;
  readonly achievedRate: number;
  readonly achievedBurstRate: number;
  readonly postgresCoresBaseline: number | null;
  readonly postgresCoresSustained: number | null;
  readonly postgresCoresBurst: number | null;
  // during the sustained phase with partial text, summed over the replicas
  readonly liveUpsertsPerSec: number;
  readonly liveBytesPerSec: number;
  readonly payloadBytesPerEvent: number;
  readonly maxPending: number;
  readonly serverMetrics: string[];
  readonly drainSeconds: number;
};

const viewerResult = z.object({
  result: z.object({
    open: z.number(),
    liveFrames: z.number(),
    closedEarly: z.number(),
    ended: z.number(),
    wanted: z.number(),
    perViewer: z.array(z.object({ key: z.string(), count: z.number(), lastSeq: z.number(), gaps: z.number(), dups: z.number(), ended: z.boolean() })),
    atSeconds: z.array(z.number()),
    latencies: z.array(z.number()),
  }),
  timedOut: z.boolean(),
});

const phaseStats = (atSeconds: readonly number[], latencies: readonly number[], fromSec: number, toSec: number, events: number): PhaseStats => {
  const picked: number[] = [];
  atSeconds.forEach((sec, i) => {
    const latency = latencies[i];
    if (latency !== undefined && sec >= fromSec && sec < toSec) picked.push(latency);
  });
  picked.sort((a, b) => a - b);
  return {
    events,
    deliveries: picked.length,
    p50: percentile(picked, 50),
    p95: percentile(picked, 95),
    p99: percentile(picked, 99),
    max: picked[picked.length - 1] ?? Number.NaN,
  };
};

const totalsOf = async (servers: readonly ServerProc[], token: string): Promise<Totals> => {
  let events = 0;
  let liveUpserts = 0;
  let liveBytes = 0;
  let payloadBytes = 0;
  for (const server of servers) {
    const m = await readMetrics(server.baseUrl, token);
    events += m.appender.eventsCommitted;
    liveUpserts += m.appender.liveUpserts;
    liveBytes += m.appender.liveBytes;
    payloadBytes += m.appender.payloadBytes;
  }
  return { events, liveUpserts, liveBytes, payloadBytes };
};

type Streamer = { readonly taskId: TaskId; readonly script: LoadScript; readonly client: RunnerClient };

export const runLoad = async (db: LoadDatabase, opts: LoadOptions, log: (line: string) => void): Promise<LoadResult> => {
  const servers: ServerProc[] = [];
  let viewersProc: ReturnType<typeof spawnNode> | null = null;
  const runners: RunnerClient[] = [];
  let liveTimer: NodeJS.Timeout | null = null;
  // a token for this run only: random, in the servers' environment and the runners' options, nowhere else
  const token = newRunnerToken();
  try {
    const taskIds = Array.from({ length: opts.tasks }, (_, i) => TaskId.parse(`load-${String(i)}`));
    await seedTasks(db.pool, taskIds, "alex");
    for (let i = 0; i < opts.replicas; i += 1) servers.push(await startServerProc(db.url, `load-replica-${String(i)}`, token));
    const first = servers[0];
    if (first === undefined) throw new Error("no server");
    const cookie = await login(first.baseUrl, "alex");
    log(`load: ${String(opts.replicas)} server processes up`);

    const proc = spawnNode(["src/harness/viewers.ts"], {
      OSTRA_LOAD_VIEWERS: JSON.stringify({
        bases: servers.map((s) => s.baseUrl),
        cookie,
        tasks: taskIds,
        viewersPerTask: opts.viewersPerTask,
        timeoutMs: (opts.baselineSec + opts.durationSec + 90) * 1000,
      }),
    });
    viewersProc = proc;
    const ready = z.object({ ready: z.number(), wanted: z.number() }).parse(JSON.parse(await proc.firstLine));
    log(`load: ${String(ready.ready)} of ${String(ready.wanted)} viewers connected`);
    // the result line comes later; read the rest of stdout
    let outBuffer = "";
    const resultLine = new Promise<string>((resolve) => {
      proc.child.stdout.on("data", (chunk: Buffer) => {
        outBuffer += chunk.toString("utf8");
        const newline = outBuffer.indexOf("\n");
        if (newline >= 0) resolve(outBuffer.slice(0, newline));
      });
      proc.child.once("exit", () => {
        resolve(outBuffer.split("\n")[0] ?? "");
      });
    });

    for (let r = 0; r < opts.runners; r += 1) {
      const target = servers[r % servers.length];
      if (target === undefined) continue;
      const client = createRunnerClient({ baseUrl: target.baseUrl, token, batchMs: opts.batchMs });
      client.start();
      runners.push(client);
    }
    const scripts = taskIds.map((id) => createLoadScript(id, { largeOutputEvery: opts.largeOutputEvery, liveStepChars: LIVE_STEP_CHARS, segmentChars: LIVE_SEGMENT_CHARS }));
    // A task always uses the same runner client (its events and its partial text go together). The streaming
    // tasks are every `streamEvery`-th one, so the plain `index % runners` would put them all on one runner,
    // and one server: the index is shifted by the number of streamers before it to spread them.
    const runnerFor = (index: number): RunnerClient | undefined => runners[(index + Math.floor(index / opts.streamEvery)) % runners.length];
    // every `streamEvery`-th task streams partial text, spread over five 50 ms slots so each sends every 250 ms
    const streamers: Streamer[] = [];
    taskIds.forEach((taskId, index) => {
      const script = scripts[index];
      const client = runnerFor(index);
      if (index % opts.streamEvery === 0 && script !== undefined && client !== undefined) streamers.push({ taskId, script, client });
    });
    const setStreaming = (on: boolean): void => {
      for (const streamer of streamers) streamer.script.setStreaming(on);
    };
    let slot = 0;
    liveTimer = setInterval(() => {
      slot = (slot + 1) % 5;
      streamers.forEach((streamer, i) => {
        if (i % 5 !== slot) return;
        const frame = streamer.script.liveFrame();
        if (frame !== null) streamer.client.live(streamer.taskId, frame);
      });
    }, 50);

    let cursor = 0;
    let sent = 0;
    let maxPending = 0;
    const emitOne = (): void => {
      const index = cursor % taskIds.length;
      cursor += 1;
      const taskId = taskIds[index];
      const script = scripts[index];
      const client = runnerFor(index);
      if (taskId === undefined || script === undefined || client === undefined) return;
      client.emit(taskId, script.next());
      sent += 1;
    };
    const pending = (): number => runners.reduce((n, r) => n + r.pendingCount(), 0);
    const runPhase = async (ratePerSec: number, durationMs: number): Promise<{ events: number; seconds: number }> => {
      const start = performance.now();
      let emitted = 0;
      for (;;) {
        const elapsedMs = performance.now() - start;
        if (elapsedMs >= durationMs) break;
        const due = Math.floor((ratePerSec * elapsedMs) / 1000) - emitted;
        for (let i = 0; i < due; i += 1) emitOne();
        emitted += due;
        maxPending = Math.max(maxPending, pending());
        await sleep(2);
      }
      return { events: emitted, seconds: (performance.now() - start) / 1000 };
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 40 && pending() > 0; i += 1) await sleep(250);
      await sleep(2000);
    };
    const sec = (ms: number): number => Math.floor(ms / 1000);

    // warm-up (no partial text), then the baseline (events only), then the sustained phase with partial text, then the burst
    log(`load: warm-up at ${String(Math.round(opts.rate / 5))}/s`);
    await runPhase(opts.rate / 5, 3000);
    await settle();

    log(`load: baseline, events only, ${String(opts.rate)}/s for ${String(opts.baselineSec)} s`);
    const baseCpu0 = await databaseCpuSeconds(db.postmasterPid);
    const baselineStart = Date.now();
    const baseline = await runPhase(opts.rate, opts.baselineSec * 1000);
    const baselineEnd = Date.now();
    const baseCpu1 = await databaseCpuSeconds(db.postmasterPid);
    await settle();

    setStreaming(true);
    log(`load: sustained ${String(opts.rate)}/s for ${String(opts.durationSec)} s, ${String(streamers.length)} tasks streaming partial text`);
    // let the first segments open, so the phase starts with live frames flowing
    await sleep(1000);
    const totals0 = await totalsOf(servers, token);
    const cpu0 = await databaseCpuSeconds(db.postmasterPid);
    const sustainedStart = Date.now();
    const sustained = await runPhase(opts.rate, opts.durationSec * 1000);
    const sustainedEnd = Date.now();
    const cpu1 = await databaseCpuSeconds(db.postmasterPid);
    const totals1 = await totalsOf(servers, token);
    // let the sustained phase drain before the burst, so the two are measured apart
    await settle();

    const cpu2 = await databaseCpuSeconds(db.postmasterPid);
    const burstStart = Date.now();
    log(`load: burst of ${String(opts.burst)} events in 1 s`);
    const burst = await runPhase(opts.burst, 1000);
    const burstEnd = Date.now();

    const drainStarted = Date.now();
    for (const client of runners) await client.drain(60_000);
    const drainSeconds = (Date.now() - drainStarted) / 1000;
    const cpu3 = await databaseCpuSeconds(db.postmasterPid);
    const burstWindowSec = (Date.now() - burstStart) / 1000;
    clearInterval(liveTimer);
    liveTimer = null;

    const cores = (from: number | null, to: number | null, seconds: number): number | null => (from === null || to === null ? null : (to - from) / seconds);
    const postgresCoresBaseline = cores(baseCpu0, baseCpu1, (baselineEnd - baselineStart) / 1000);
    const postgresCoresSustained = cores(cpu0, cpu1, (sustainedEnd - sustainedStart) / 1000);
    const postgresCoresBurst = cores(cpu2, cpu3, burstWindowSec);

    // end markers: every viewer finishes when it sees its task's marker
    const endClient = runners[0];
    if (endClient === undefined) throw new Error("no runner");
    for (const [i, taskId] of taskIds.entries()) {
      const client = runnerFor(i) ?? endClient;
      client.emit(taskId, { kind: "session.config_changed", key: "end", value: "1" });
      sent += 1;
    }
    for (const client of runners) await client.drain(60_000);
    const line = await withTimeout(resultLine, (opts.baselineSec + opts.durationSec + 80) * 1000, "");
    const result = viewerResult.parse(JSON.parse(line)).result;

    const stored = await rows(
      db.pool,
      z.object({ n: z.coerce.number() }),
      "SELECT coalesce(sum(next_seq - 1), 0) AS n FROM task_counters WHERE task_id LIKE 'load-%'",
    );
    const serverMetrics: string[] = [];
    for (const server of servers) {
      const m = await readMetrics(server.baseUrl, token);
      serverMetrics.push(
        `${m.replica}: ${String(m.appender.flushes)} commits (avg ${String(Math.round(m.appender.flushMsTotal / Math.max(1, m.appender.flushes)))} ms, max ${String(Math.round(m.appender.flushMsMax))} ms, largest observed ${String(m.appender.maxBatchEvents)} events), ${String(m.appender.liveUpserts)} partial-text upserts, tailer ${String(m.tailer.ticks)} ticks / ${String(m.tailer.eventQueries)} event queries / ${String(m.tailer.liveQueries)} live queries, ${String(m.sse.slowDisconnects)} slow-viewer disconnects, rss ${String(Math.round(m.memory / 1e6))} MB`,
      );
    }

    const baselineStats = phaseStats(result.atSeconds, result.latencies, sec(baselineStart) + 1, sec(baselineEnd) + 1, baseline.events);
    const sustainedStats = phaseStats(result.atSeconds, result.latencies, sec(sustainedStart) + 1, sec(sustainedEnd) + 1, sustained.events);
    const burstStats = phaseStats(result.atSeconds, result.latencies, sec(burstStart), sec(burstEnd) + 2, burst.events);
    const delivered = result.perViewer.reduce((n, v) => n + v.count, 0);
    const gaps = result.perViewer.reduce((n, v) => n + v.gaps, 0);
    const duplicates = result.perViewer.reduce((n, v) => n + v.dups, 0);
    const lossy = result.perViewer.filter((v) => !v.ended).length;
    const sustainedSeconds = (sustainedEnd - sustainedStart) / 1000;
    const sustainedEvents = Math.max(1, totals1.events - totals0.events);
    return {
      options: opts,
      sent,
      stored: stored[0]?.n ?? 0,
      viewersOpen: result.open,
      viewersWanted: result.wanted,
      delivered,
      expectedDeliveries: sent * opts.viewersPerTask,
      liveFramesDelivered: result.liveFrames,
      streamingTasks: streamers.length,
      gaps,
      duplicates,
      lossy,
      baseline: baselineStats,
      sustained: sustainedStats,
      burst: burstStats,
      achievedBaselineRate: baseline.events / baseline.seconds,
      achievedRate: sustained.events / sustained.seconds,
      achievedBurstRate: burst.events / burst.seconds,
      postgresCoresBaseline,
      postgresCoresSustained,
      postgresCoresBurst,
      liveUpsertsPerSec: (totals1.liveUpserts - totals0.liveUpserts) / sustainedSeconds,
      liveBytesPerSec: (totals1.liveBytes - totals0.liveBytes) / sustainedSeconds,
      payloadBytesPerEvent: (totals1.payloadBytes - totals0.payloadBytes) / sustainedEvents,
      maxPending,
      serverMetrics,
      drainSeconds,
    };
  } finally {
    if (liveTimer !== null) clearInterval(liveTimer);
    for (const client of runners) await client.stop().catch(() => undefined);
    if (viewersProc !== null) await killTree(viewersProc.pid);
    for (const server of servers) await server.stop();
  }
};

const ms = (n: number): string => (Number.isNaN(n) ? "n/a" : `${String(Math.round(n))} ms`);
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

const pgNote = (cores: number | null): string => (cores === null ? "not measured" : `${cores.toFixed(2)} cores = ${String(Math.round((cores / 4) * 100))}% of 4 vCPU`);

export const describeLoad = (r: LoadResult): string => {
  const live = r.postgresCoresSustained;
  const base = r.postgresCoresBaseline;
  const cost = live === null || base === null ? "not measured" : `${(live - base).toFixed(2)} cores (${String(Math.round(((live - base) / 4) * 100))}% of 4 vCPU)`;
  return [
    `${String(r.options.tasks)} tasks (${String(r.streamingTasks)} streaming partial text), ${String(r.viewersOpen)} viewers (${String(r.options.viewersPerTask)} per task) over ${String(r.options.replicas)} server processes and ${String(r.options.runners)} runner clients; viewers are Node clients, not browsers`,
    `events only, ${String(Math.round(r.achievedBaselineRate))}/s for ${String(r.options.baselineSec)} s: p50 ${ms(r.baseline.p50)}, p95 ${ms(r.baseline.p95)}, p99 ${ms(r.baseline.p99)}, max ${ms(r.baseline.max)}; Postgres ${pgNote(r.postgresCoresBaseline)}`,
    `with partial text, ${String(Math.round(r.achievedRate))}/s for ${String(r.options.durationSec)} s: p50 ${ms(r.sustained.p50)}, p95 ${ms(r.sustained.p95)}, p99 ${ms(r.sustained.p99)}, max ${ms(r.sustained.max)} (${String(r.sustained.deliveries)} deliveries); Postgres ${pgNote(r.postgresCoresSustained)}`,
    `the UNLOGGED partial-text table: ${String(Math.round(r.liveUpsertsPerSec))} upserts/s carrying ${kb(r.liveBytesPerSec)}/s of text (each upsert rewrites the segment's whole text, up to ${String(LIVE_SEGMENT_CHARS)} characters), on top of events averaging ${String(Math.round(r.payloadBytesPerEvent))} bytes of payload; it cost ${cost} over the events-only phase; ${String(r.liveFramesDelivered)} live frames reached the viewers`,
    `burst ${String(Math.round(r.achievedBurstRate))}/s for 1 s (${String(r.burst.events)} events): p50 ${ms(r.burst.p50)}, p95 ${ms(r.burst.p95)}, p99 ${ms(r.burst.p99)}, max ${ms(r.burst.max)}; Postgres during the burst and its drain ${pgNote(r.postgresCoresBurst)}`,
    `${String(r.sent)} events sent, ${String(r.stored)} stored, ${String(r.delivered)} of ${String(r.expectedDeliveries)} deliveries, gaps ${String(r.gaps)}, duplicates ${String(r.duplicates)}, viewers that never saw their end marker ${String(r.lossy)}; runner-side queue peaked at ${String(r.maxPending)} events, drained in ${String(Math.round(r.drainSeconds))} s`,
    ...r.serverMetrics,
  ].join("\n          ");
};

export const loadCriteria = (r: LoadResult | null, full: boolean, error: string | null): Criterion[] => {
  if (error !== null) return [fail(BAR, "Load run completed", error)];
  if (r === null) return [skipped(BAR, "Load run", "a run of `pnpm load`")];
  const lossless = r.stored === r.sent && r.delivered === r.expectedDeliveries && r.gaps === 0 && r.duplicates === 0 && r.lossy === 0 && r.viewersOpen === r.viewersWanted;
  const out: Criterion[] = [];
  const scaled = !full;
  // Postgres is judged in both phases, in the scaled run too: under 2 cores (50% of 4 vCPU) on this machine's cores.
  const pgOk = (cores: number | null): boolean => cores === null || cores < 2;
  const pgMeasured = r.postgresCoresSustained !== null && r.postgresCoresBurst !== null;
  const shape = `${String(r.options.rate)}/s sustained with partial text on 1 task in ${String(r.options.streamEvery)} and 4 to 20 KB command outputs, ${String(r.options.burst)} burst`;
  out.push(
    verdict(
      BAR,
      `${scaled ? "Scaled-down" : "Full-rate"} run on this machine (${shape}): nothing lost, p99 under 500 ms from the runner to an SSE client (a Node client, not a browser) in the sustained phase and in the burst, Postgres under 2 cores in both`,
      lossless && r.sustained.p99 < 500 && r.burst.p99 < 500 && pgOk(r.postgresCoresSustained) && pgOk(r.postgresCoresBurst),
      describeLoad(r),
    ),
  );
  if (!pgMeasured) {
    out.push(skipped(BAR, "Postgres under 50% of 4 vCPU", "a way to read the database's CPU time (embedded-postgres on this machine, a Linux host, or OSTRA_SPIKE_POSTMASTER_PID)"));
  }
  if (scaled) {
    out.push(
      skipped(
        BAR,
        "The bar itself: 5,000/s sustained, a burst of 10,000, p99 under 500 ms, Postgres under 50% of 4 vCPU",
        "a Linux host with 4 vCPU dedicated to Postgres and the real 1,000-task shape: run `pnpm load --full` there (this machine ran the scaled-down shape above)",
      ),
    );
  } else if (process.platform !== "linux") {
    out.push(
      skipped(BAR, "The same full run on the reference host (Linux, 4 vCPU for Postgres)", `a Linux machine: this run was on ${process.platform}, with the database sharing this machine's cores with everything else`),
    );
  }
  return out;
};
