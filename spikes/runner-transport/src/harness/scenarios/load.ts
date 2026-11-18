import path from "node:path";
import { z } from "zod";
import { SessionId } from "../../protocol/ids.ts";
import { sleep } from "../../shared/stats.ts";
import { cleanEnv, dispatchMany, metrics, registerRunners, startReplica, stopMany, verifyMany, type Ctx, type Replica } from "../cluster.ts";
import { tcpProxy } from "../net-proxies.ts";
import { spawnNode, type Child } from "../procs.ts";
import { spike1Rate } from "../spike1-rate.ts";
import { check, skipped, type Check } from "../report.ts";
import { ms } from "./common.ts";

const SRC = path.resolve(import.meta.dirname, "..", "..");
const big = z.coerce.number().int();

const Summary = z.object({ n: z.number(), p50: z.number(), p95: z.number(), p99: z.number(), max: z.number() });
const LgReport = z.looseObject({
  t: z.literal("report"),
  peers: z.number(),
  connected: z.number(),
  welcomes: z.number(),
  closes: z.number(),
  fallbacks: z.number(),
  connectMs: Summary,
  ackMs: Summary,
  rss: z.number(),
  sessions: z.record(z.string(), z.object({ lastSeq: z.number(), ackedUpTo: z.number(), state: z.string() })),
});
type LgReport = z.infer<typeof LgReport>;

const lgReport = async (lg: Child): Promise<LgReport | undefined> => {
  const from = lg.lines.length;
  lg.send({ cmd: "report" });
  const r = LgReport.safeParse(await lg.waitFor((l) => l["t"] === "report", 30_000, from));
  return r.success ? r.data : undefined;
};

const loadgen = (ctx: Ctx, name: string, server: string, count: number, prefix: string, eventsPerSec: number, eventBytes: number): Child =>
  spawnNode(
    name,
    path.join(SRC, "loadgen", "loadgen.ts"),
    [
      `--server=${server}`,
      `--count=${String(count)}`,
      `--prefix=${prefix}`,
      `--events-per-sec=${String(eventsPerSec)}`,
      `--event-bytes=${String(eventBytes)}`,
      "--connect-per-sec=200",
    ],
    cleanEnv({ SPIKE_AUTH_SECRET: ctx.secret, NODE_EXTRA_CA_CERTS: ctx.certs.bundle }),
  );

const waitConnected = async (lg: Child, count: number, timeoutMs: number): Promise<LgReport | undefined> => {
  const until = Date.now() + timeoutMs;
  let last: LgReport | undefined;
  while (Date.now() < until) {
    last = await lgReport(lg);
    if (last !== undefined && last.connected >= count) return last;
    await sleep(2_000);
  }
  return last;
};

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Criterion 4, scaled down here: connections on one replica, then sessions on three. */
export const load = async (ctx: Ctx, full: boolean): Promise<Check[]> => {
  const conns = full ? 2_000 : 1_000;
  const sessions = full ? 1_000 : 250;
  const s1 = await spike1Rate(path.resolve(ctx.root, ".."));
  const perMin = s1.eventsPerMin;
  const rate = perMin / 60;
  const size = s1.bytesPerEvent === undefined ? `${String(s1.padBytes)} B of padding` : `about ${s1.bytesPerEvent.toFixed(0)} B each`;
  const rateNote = `${String(perMin)} events/min per session, ${size} (from ${s1.source})`;
  process.stdout.write(`load: ${rateNote}\n`);
  const checks: Check[] = [];
  const scaleTag = full ? "" : " [scaled down, not the bar]";

  // --- one replica, many connections ---
  {
    const rep = await startReplica(ctx, "l1", { pool: 16, timeScale: 1 });
    const lg = loadgen(ctx, "loadgen-conns", `https://localhost:${String(rep.port)}`, conns, "lc", 0, 0);
    try {
      const m0 = await metrics(ctx, rep.port);
      await lg.waitFor((l) => l["t"] === "all-started", (conns / 200) * 1000 + 120_000);
      const up = await waitConnected(lg, conns, 120_000);
      // Hold through more than two ping rounds and a presence write.
      await sleep(50_000);
      const m1 = await metrics(ctx, rep.port);
      const held = await lgReport(lg);
      const perK = m0 === undefined || m1 === undefined ? undefined : ((m1.rss - m0.rss) / conns) * 1000;
      const ok = held?.connected === conns && held.closes === 0 && m1?.wsPeers === conns;
      checks.push(
        check(
          `one replica holds ${String(conns)} connections for 50 s${scaleTag}`,
          ok,
          `${String(held?.connected ?? 0)}/${String(conns)} connected, ${String(held?.closes ?? 0)} dropped; replica sees ${String(m1?.wsPeers ?? 0)} sockets; replica RSS ${m1 === undefined ? "?" : mb(m1.rss)}, about ${perK === undefined ? "?" : mb(perK)} per 1,000 sockets; connect p99 ${ms(up?.connectMs.p99 ?? 0)}`,
          { held, rssBefore: m0?.rss, rssAfter: m1?.rss, perThousand: perK },
        ),
      );
    } finally {
      await lg.kill9();
      await rep.child.kill9();
    }
  }

  // --- three replicas, one Postgres, many sessions ---
  {
    const reps: Replica[] = [];
    for (const n of ["l2a", "l2b", "l2c"]) reps.push(await startReplica(ctx, n, { pool: 16, timeScale: 1 }));
    const lb = await tcpProxy(() => reps.map((r) => ({ host: "127.0.0.1", port: r.port })));
    const ids = Array.from({ length: sessions }, (_, i) => `ls-${String(i)}`);
    await registerRunners(ctx, ids);
    const lg = loadgen(ctx, "loadgen-sessions", `https://localhost:${String(lb.port)}`, sessions, "ls", rate, s1.padBytes);
    try {
      await lg.waitFor((l) => l["t"] === "all-started", (sessions / 200) * 1000 + 120_000);
      await waitConnected(lg, sessions, 120_000);
      const ds = await dispatchMany(ctx, ids.map((runnerId, i) => ({ runnerId, name: `load-${String(i)}` })));
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        const r = await lgReport(lg);
        if (r !== undefined && Object.keys(r.sessions).length >= sessions) break;
        await sleep(1_000);
      }
      await sleep(10_000);
      lg.send({ cmd: "reset-latency" });
      const countRows = async (): Promise<number> =>
        z.object({ n: big }).parse((await ctx.db.query("SELECT count(*) AS n FROM agent_event WHERE session_id LIKE 'sess-load-%'")).rows[0]).n;
      const notes = async (): Promise<number> =>
        (await Promise.all(reps.map((r) => metrics(ctx, r.port)))).reduce((a, m) => a + (m?.counters.notifications ?? 0), 0);
      const c0 = await countRows();
      const n0 = await notes();
      const t0 = Date.now();
      await sleep(60_000);
      const c1 = await countRows();
      const n1 = await notes();
      const t1 = Date.now();
      const steady = await lgReport(lg);
      const mets = await Promise.all(reps.map((r) => metrics(ctx, r.port)));
      const rowsPerSec = ((c1 - c0) * 1000) / (t1 - t0);
      const offered = sessions * rate;
      await stopMany(ctx, ds.map((d, i) => ({ runnerId: ids[i] ?? "", session: d.session })));
      let drained: LgReport | undefined;
      const dUntil = Date.now() + 90_000;
      while (Date.now() < dUntil) {
        drained = await lgReport(lg);
        const all = drained === undefined ? [] : Object.values(drained.sessions);
        if (all.length >= sessions && all.every((s) => s.state !== "running" && s.ackedUpTo === s.lastSeq)) break;
        await sleep(1_000);
      }
      const expected = new Map<string, number>();
      for (const [sid, s] of Object.entries(drained?.sessions ?? {})) expected.set(SessionId.parse(sid), s.lastSeq);
      const v = await verifyMany(ctx, expected);
      const ok = v.bad === 0 && v.ok === sessions && rowsPerSec >= offered * 0.95 && (steady?.ackMs.p99 ?? Infinity) < 1_000;
      checks.push(
        check(
          `three replicas and one Postgres carry ${String(sessions)} sessions at ${rateNote}${scaleTag}`,
          ok,
          `${rowsPerSec.toFixed(0)} rows/s stored for ${offered.toFixed(0)} offered; ack p50 ${ms(steady?.ackMs.p50 ?? 0)}, p99 ${ms(steady?.ackMs.p99 ?? 0)} (bar used here: p99 < 1 s, my working value); ${(((n1 - n0) * 1000) / (t1 - t0)).toFixed(1)} notifications/s; ingest txn p99 per replica ${mets.map((m) => ms(m?.ingestMs.p99 ?? 0)).join(" / ")}; after drain ${String(v.ok)}/${String(sessions)} sessions exactly once (${String(v.stored)}/${String(v.expected)} events)`,
          { rowsPerSec, offered, ack: steady?.ackMs, verify: v, replicas: mets },
        ),
      );
    } finally {
      await lg.kill9();
      for (const r of reps) await r.child.kill9();
      await lb.close();
    }
  }

  if (!full) {
    checks.push(skipped("one replica holds 2,000 connections", "needs the Linux machine: run `pnpm spike:full-load` there"));
    checks.push(
      skipped(
        "three replicas and one Postgres carry 1,000 sessions at spike 1's rates",
        `needs the Linux machine${s1.fromSpike1 ? "" : " and spike 1's recorded rate (OSTRA_SPIKE1_EVENTS_PER_MIN, or a spike 1 report.json)"}: run \`pnpm spike:full-load\` there`,
      ),
    );
  }
  return checks;
};
