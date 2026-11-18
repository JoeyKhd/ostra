import { z } from "zod";
import { scaledTimers } from "../../protocol/timers.ts";
import { sleep } from "../../shared/stats.ts";
import { commandResult, dispatch, runner, steer, steerReceipts, waitWelcome, type Ctx, type Replica } from "../cluster.ts";
import { tcpProxy } from "../net-proxies.ts";
import { num } from "../procs.ts";
import { check, skipped, type Check } from "../report.ts";
import { secs } from "./common.ts";

const big = z.coerce.number().int();

/**
 * Criterion 6, simulated: the runner's event loop is frozen (Atomics.wait) for
 * the grace plus a minute, with its self-fence off, as if its clock hadn't
 * counted the sleep. The server's refusal has to be the guarantee on its own.
 */
export const sleepThrough = async (ctx: Ctx, replicas: readonly Replica[]): Promise<Check[]> => {
  const t = scaledTimers(ctx.timeScale);
  const lb = await tcpProxy(() => replicas.map((r) => ({ host: "127.0.0.1", port: r.port })));
  const r = runner(ctx, { id: "sleeper", serverUrl: `https://localhost:${String(lb.port)}`, testHooks: true, args: ["--events-per-sec=20", "--self-fence=false"] });
  const name = `runner asleep for the grace + 1 min (${secs(t.graceMs + 60_000 / ctx.timeScale)}), self-fence off, simulated by freezing its event loop`;
  const real = skipped(
    "a real laptop sleep",
    "needs a laptop runner put to sleep by hand against a server on another machine (macOS, Windows and Linux): see README, \"What's left\"",
  );
  try {
    if ((await waitWelcome(r.child, 20_000)) === undefined) return [check(name, false, "no welcome"), real];
    const d = await dispatch(ctx, r.id, "sleeper");
    await r.child.waitFor((l) => l["t"] === "dispatch-accepted", 20_000);
    await sleep(5_000);
    const freezeMs = t.graceMs + 60_000 / ctx.timeScale;
    r.child.send({ cmd: "freeze", ms: Math.round(freezeMs) });
    const frozenAt = Date.now();
    await sleep(60_000 / ctx.timeScale);
    // A steer the member sends while the laptop sleeps, valid for 2 minutes.
    const s = await steer(ctx, r.id, d.session, { notify: true, notAfterMs: Date.now() + 120_000 / ctx.timeScale });
    const thaw = await r.child.waitFor((l) => l["t"] === "thaw", freezeMs + 30_000);
    const thawAt = num(thaw, "ts") ?? Date.now();
    await waitWelcome(r.child, t.backoffMaxMs * 2 + 30_000, r.child.lines.indexOf(thaw ?? {}) + 1);
    await r.child.waitFor((l) => l["t"] === "stale-lease-refused", 30_000);
    await sleep(3_000);

    const q = await ctx.db.query(
      `SELECT t.state, t.stopped_reason, t.lease_epoch, (extract(epoch FROM t.stopped_at) * 1000)::float8 AS stopped_ms,
         (SELECT count(*) FROM agent_event e WHERE e.session_id = s.id AND e.received_at > t.stopped_at) AS after_stop,
         (SELECT coalesce(sum(count), 0) FROM stale_refusal x WHERE x.session_id = s.id AND x.at > to_timestamp($2 / 1000.0)) AS refused_after_wake
       FROM session s JOIN task t ON t.id = s.task_id WHERE s.id = $1`,
      [d.session, thawAt],
    );
    const row = z
      .object({ state: z.string(), stopped_reason: z.string().nullable(), lease_epoch: big, stopped_ms: z.number().nullable(), after_stop: big, refused_after_wake: big })
      .parse(q.rows[0]);
    const res = await commandResult(ctx, s.id);
    const applied = steerReceipts(r.child).has(s.id);
    const ok =
      row.state === "stopped" &&
      row.stopped_reason === "runner-lost" &&
      row.after_stop === 0 &&
      row.refused_after_wake > 0 &&
      !applied &&
      res?.result === "rejected" &&
      res.reason === "expired";
    const result = check(
      name,
      ok,
      `the server stopped the task ${row.stopped_ms === null ? "never" : secs(row.stopped_ms - frozenAt)} into the sleep (epoch now ${String(row.lease_epoch)}); after waking, ${String(row.refused_after_wake)} event writes were refused and ${String(row.after_stop)} rows stored after the stop; the steer sent during the sleep was ${applied ? "APPLIED LATE" : `not applied (result: ${res?.result ?? "none"}${res?.reason === null || res?.reason === undefined ? "" : ` ${res.reason}`})`}`,
    );
    if (ctx.timeScale !== 1) {
      return [skipped(name, `quick mode, timers / ${String(ctx.timeScale)}: run \`pnpm spike\` for the real durations. Scaled result: ${result.result}: ${result.note}`), real];
    }
    return [result, real];
  } finally {
    await r.child.kill9();
    await lb.close();
  }
};
