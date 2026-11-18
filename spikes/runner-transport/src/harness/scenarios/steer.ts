import type { SessionId } from "../../protocol/ids.ts";
import { sleep, summarize, type Summary } from "../../shared/stats.ts";
import { dispatch, metrics, runner, steer, steerReceipts, stopSession, waitWelcome, type Ctx, type Replica, type RunnerProc } from "../cluster.ts";
import { num } from "../procs.ts";
import { check, type Check } from "../report.ts";
import { ms } from "./common.ts";

const STEERS_NOTIFY = 400;
const STEERS_SWEEP = 300;

/**
 * Criterion 3: runners split across two replicas; "the panel" (this harness,
 * its own Postgres connection) writes steers into the outbox. With NOTIFY the
 * holding replica wakes at once; with notifications off only its 2 s sweep finds them.
 */
export const steerLatency = async (ctx: Ctx, replicas: readonly Replica[]): Promise<Check[]> => {
  const [a, b] = replicas;
  if (a === undefined || b === undefined) return [];
  const runners: RunnerProc[] = [];
  const sessions = new Map<string, SessionId>();
  try {
    for (let i = 0; i < 10; i += 1) {
      const rep = i % 2 === 0 ? a : b;
      runners.push(runner(ctx, { id: `steer-${String(i)}`, serverUrl: `https://localhost:${String(rep.port)}`, args: ["--events-per-sec=2"] }));
    }
    for (const r of runners) {
      if ((await waitWelcome(r.child, 20_000)) === undefined) return [check("steer latency", false, `${r.id} never connected`)];
      const d = await dispatch(ctx, r.id, `steer-${r.id}`);
      sessions.set(r.id, d.session);
    }
    for (const r of runners) await r.child.waitFor((l) => l["t"] === "dispatch-accepted", 20_000);
    await sleep(1_000);

    const run = async (count: number, notify: boolean): Promise<{ lat: Summary; lost: number }> => {
      const sent: { id: string; t0: number; r: RunnerProc }[] = [];
      for (let i = 0; i < count; i += 1) {
        const r = runners[Math.floor(Math.random() * runners.length)];
        const session = r === undefined ? undefined : sessions.get(r.id);
        if (r === undefined || session === undefined) continue;
        const s = await steer(ctx, r.id, session, { notify });
        sent.push({ ...s, r });
        await sleep(10 + Math.random() * 30);
      }
      await sleep(notify ? 2_000 : 5_000);
      const lat: number[] = [];
      let lost = 0;
      const receipts = new Map(runners.map((r) => [r.id, steerReceipts(r.child)]));
      for (const s of sent) {
        const at = receipts.get(s.r.id)?.get(s.id);
        if (at === undefined) lost += 1;
        else lat.push(at - s.t0);
      }
      return { lat: summarize(lat), lost };
    };

    const before = await Promise.all([metrics(ctx, a.port), metrics(ctx, b.port)]);
    const withNotify = await run(STEERS_NOTIFY, true);
    const sweepOnly = await run(STEERS_SWEEP, false);
    const after = await Promise.all([metrics(ctx, a.port), metrics(ctx, b.port)]);
    const notes = after.reduce((x, m, i) => x + (m?.counters.notifications ?? 0) - (before[i]?.counters.notifications ?? 0), 0);

    const checks: Check[] = [
      check(
        "p99 under 500 ms with NOTIFY (two replicas, 10 runners)",
        withNotify.lost === 0 && withNotify.lat.p99 < 500,
        `${String(withNotify.lat.n)} steers: p50 ${ms(withNotify.lat.p50)}, p99 ${ms(withNotify.lat.p99)}, max ${ms(withNotify.lat.max)}; ${String(withNotify.lost)} lost; ${String(notes)} notifications received across replicas`,
        withNotify,
      ),
      check(
        "p99 under 2.5 s with notifications off (2 s sweep only)",
        sweepOnly.lost === 0 && sweepOnly.lat.p99 < 2_500,
        `${String(sweepOnly.lat.n)} steers: p50 ${ms(sweepOnly.lat.p50)}, p99 ${ms(sweepOnly.lat.p99)}, max ${ms(sweepOnly.lat.max)}; ${String(sweepOnly.lost)} lost`,
        sweepOnly,
      ),
    ];

    // A new connection evicts the old one: the old replica closes it with 4409.
    const first = runner(ctx, { id: "evict-me", serverUrl: `https://localhost:${String(a.port)}`, args: ["--events-per-sec=0"] });
    await waitWelcome(first.child, 20_000);
    const second = runner(ctx, { id: "evict-me", serverUrl: `https://localhost:${String(b.port)}`, args: ["--events-per-sec=0"] });
    const t0 = Date.now();
    await waitWelcome(second.child, 20_000);
    const closed = await first.child.waitFor((l) => l["t"] === "ws-closed" && l["code"] === 4409, 10_000);
    checks.push(
      check(
        "a newer connection on the other replica evicts the old one with 4409 [not the bar]",
        closed !== undefined,
        closed === undefined ? "the old connection was not closed" : `closed with 4409 ${ms((num(closed, "ts") ?? t0) - t0)} after the new one started`,
      ),
    );
    for (const r of runners) {
      const s = sessions.get(r.id);
      if (s !== undefined) await stopSession(ctx, r.id, s);
    }
    await sleep(1_000);
    await first.child.kill9();
    await second.child.kill9();
    return checks;
  } finally {
    for (const r of runners) await r.child.kill9();
  }
};
