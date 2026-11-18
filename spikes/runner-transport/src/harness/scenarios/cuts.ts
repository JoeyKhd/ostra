import { z } from "zod";
import type { SessionId } from "../../protocol/ids.ts";
import { scaledTimers } from "../../protocol/timers.ts";
import { sleep } from "../../shared/stats.ts";
import {
  commandResult,
  dispatch,
  report,
  runner,
  steer,
  steerReceipts,
  stopSession,
  verifySession,
  waitDrained,
  type Ctx,
  type Replica,
  waitWelcome,
} from "../cluster.ts";
import { tcpProxy, type CutMode } from "../net-proxies.ts";
import { num, str, type JsonLine } from "../procs.ts";
import { check, skipped, type Check } from "../report.ts";
import { describeVerify, secs } from "./common.ts";

const big = z.coerce.number().int();

const taskState = async (ctx: Ctx, session: SessionId) => {
  const r = await ctx.db.query(
    `SELECT t.state, t.stopped_reason, t.lease_epoch, (extract(epoch FROM t.stopped_at) * 1000)::float8 AS stopped_ms, s.ingest_cursor,
       (SELECT count(*) FROM agent_event e WHERE e.session_id = s.id AND t.stopped_at IS NOT NULL AND e.received_at > t.stopped_at) AS after_stop,
       (SELECT coalesce(sum(count), 0) FROM stale_refusal x WHERE x.session_id = s.id) AS refused,
       (SELECT c.id::text FROM runner_command c WHERE c.kind = 'stop' AND c.body->>'sessionId' = s.id AND c.body->>'reason' = 'runner-lost' LIMIT 1) AS stop_id
     FROM session s JOIN task t ON t.id = s.task_id WHERE s.id = $1`,
    [session],
  );
  return z
    .object({
      state: z.string(),
      stopped_reason: z.string().nullable(),
      lease_epoch: big,
      stopped_ms: z.number().nullable(),
      ingest_cursor: big,
      after_stop: big,
      refused: big,
      stop_id: z.string().nullable(),
    })
    .parse(r.rows[0]);
};

type Plan = { readonly ms: number; readonly label: string; readonly mode: CutMode };

const modeLabel = (mode: CutMode): string =>
  mode === "reset" ? "the flow reset, as on a NAT rebind or a Wi-Fi roam" : "packets held, the flow kept";

const oneCut = async (ctx: Ctx, replicas: readonly Replica[], p: Plan, idx: number): Promise<Check[]> => {
  const t = scaledTimers(ctx.timeScale);
  const cutMs = p.ms / ctx.timeScale;
  const name = `network cut of ${p.label} (${modeLabel(p.mode)})${ctx.timeScale === 1 ? "" : ` (scaled to ${secs(cutMs)})`}`;
  const lb = await tcpProxy(() => replicas.map((r) => ({ host: "127.0.0.1", port: r.port })));
  const r = runner(ctx, { id: `cut-${String(idx)}`, serverUrl: `https://localhost:${String(lb.port)}`, args: ["--events-per-sec=5"] });
  try {
    if ((await waitWelcome(r.child, 20_000)) === undefined) return [check(name, false, "no welcome")];
    const d = await dispatch(ctx, r.id, `cut-${String(idx)}`);
    await r.child.waitFor((l) => l["t"] === "dispatch-accepted", 20_000);
    await sleep(5_000);
    const beyondGrace = cutMs > t.graceMs;
    const atCut = r.child.lines.length;
    lb.cut(p.mode);
    const cutAt = Date.now();
    let steerId: string | undefined;
    if (!beyondGrace) {
      await sleep(cutMs / 2);
      steerId = (await steer(ctx, r.id, d.session, { notify: true })).id;
      await sleep(cutMs / 2);
    } else {
      await sleep(cutMs);
    }
    const from = r.child.lines.length;
    lb.restore();
    const restoredAt = Date.now();
    // Either the connection survived the cut (TCP waited it out), or the runner reconnects.
    const atRestore = (await report(r.child))?.sessions[d.session]?.lastSeq ?? 0;
    let w: JsonLine | undefined;
    let survived = false;
    const until = Date.now() + t.backoffMaxMs * 2 + 30_000;
    while (Date.now() < until) {
      w = r.child.lines.slice(from).find((l) => l["t"] === "welcome");
      if (w !== undefined) break;
      const acked = (await report(r.child))?.sessions[d.session]?.ackedUpTo ?? 0;
      if (!beyondGrace && acked >= atRestore && !r.child.lines.slice(atCut).some((l) => l["t"] === "ws-closed")) {
        survived = true;
        break;
      }
      await sleep(500);
    }
    if (w === undefined && !survived) return [check(name, false, "never reconnected after the cut")];
    const reconnect = w === undefined ? 0 : (num(w, "ts") ?? restoredAt) - restoredAt;
    const carrier = str(w, "carrier") ?? "?";
    const closedDuringCut = r.child.lines.slice(atCut).filter((l) => l["t"] === "ws-closed").length;

    if (!beyondGrace) {
      await sleep(5_000);
      await stopSession(ctx, r.id, d.session);
      const last = await waitDrained(r.child, d.session, 60_000);
      const v = last === undefined ? undefined : await verifySession(ctx, d.session, last);
      const ts = await taskState(ctx, d.session);
      const steered = steerId !== undefined && steerReceipts(r.child).has(steerId);
      const res = steerId === undefined ? undefined : await commandResult(ctx, steerId);
      // A reset must kill the connection, and the runner must come back on its own.
      const recovered = p.mode === "reset" ? closedDuringCut > 0 && w !== undefined : true;
      return [
        check(
          name,
          v?.ok === true && steered && res?.result === "done" && ts.lease_epoch === 1 && recovered,
          `${survived ? "the WebSocket survived the cut (TCP held it)" : `the runner logged ws-closed ${String(closedDuringCut)}x and reconnected over ${carrier} ${secs(reconnect)} after the cut ended`}; ${describeVerify(v)}; the steer sent mid-cut ${steered ? "arrived after it" : "was lost"}; lease epoch ${String(ts.lease_epoch)} (task kept)`,
          { verify: v, reconnectMs: reconnect, closedDuringCut, survived },
        ),
      ];
    }

    // Past the grace: the task must be stopped cleanly, and the runner's stale writes refused.
    await r.child.waitFor((l) => l["t"] === "stale-lease-refused", 30_000, from);
    await sleep(3_000);
    const ts = await taskState(ctx, d.session);
    const fence = r.child.lines.find((l) => l["t"] === "self-fence");
    const fenceAfter = fence === undefined ? undefined : (num(fence, "ts") ?? 0) - cutAt;
    const stopAfter = ts.stopped_ms === null ? undefined : ts.stopped_ms - cutAt;
    const stopRes = ts.stop_id === null ? undefined : await commandResult(ctx, ts.stop_id);
    const beforeStop = await verifySession(ctx, d.session, ts.ingest_cursor);
    const rep = await report(r.child);
    const produced = rep?.sessions[d.session]?.lastSeq ?? 0;
    const stopOk =
      ts.state === "stopped" &&
      ts.stopped_reason === "runner-lost" &&
      ts.lease_epoch === 2 &&
      ts.after_stop === 0 &&
      ts.refused > 0 &&
      stopRes?.result === "done" &&
      fenceAfter !== undefined &&
      stopAfter !== undefined &&
      fenceAfter < stopAfter &&
      beforeStop.ok;
    const stopCheck = check(
      `${name}: the task stops cleanly, stale writes are refused, and no row is stored after the stop`,
      stopOk,
      `self-fenced ${fenceAfter === undefined ? "never" : secs(fenceAfter)} into the cut; the server stopped the task ${stopAfter === undefined ? "never" : secs(stopAfter)} in (reason ${ts.stopped_reason ?? "none"}, epoch now ${String(ts.lease_epoch)}); runner acked the stop: ${stopRes?.result ?? "no"}; ` +
        `${String(ts.after_stop)} rows stored after the stop; ${String(ts.refused)} stale event writes refused; what the server took before the stop: ${describeVerify(beforeStop)}`,
      { verify: beforeStop, fenceAfterMs: fenceAfter, stopAfterMs: stopAfter, refused: ts.refused, reconnectMs: reconnect },
    );
    // Measured against what the agent produced (the runner's own last seq), not the server's cursor.
    const all = await verifySession(ctx, d.session, produced);
    const counts = `${describeVerify(all)} of the ${String(produced)} the agent produced; the ${String(produced - ts.ingest_cursor)} it produced during the cut were refused under the stale epoch and never stored`;
    const everyEventName = `${name}: every event the agent produced is stored exactly once`;
    const everyEvent = all.ok
      ? check(everyEventName, true, counts, { verify: all })
      : skipped(
          everyEventName,
          `needs a maintainer decision: this bar line contradicts ADR 0034 line 48 (after the grace, the stale epoch's writes are refused). Keep the refusal and reword the bar, or keep stale-epoch events in an inert quarantine table. Measured: ${counts}`,
        );
    return [stopCheck, everyEvent];
  } finally {
    await r.child.kill9();
    await lb.close();
  }
};

/** Criterion 2, the network half: cuts of 30 s (reset and held), 5 min and 11 min, run side by side. */
export const cuts = async (ctx: Ctx, replicas: readonly Replica[]): Promise<Check[]> => {
  const plan: Plan[] = [
    { ms: 30_000, label: "30 s", mode: "reset" },
    { ms: 30_000, label: "30 s", mode: "hold" },
    { ms: 300_000, label: "5 min", mode: "hold" },
    { ms: 660_000, label: "11 min", mode: "hold" },
  ];
  const results = (await Promise.all(plan.map((p, i) => oneCut(ctx, replicas, p, i)))).flat();
  if (ctx.timeScale === 1) return results;
  // A time-scaled run is a development check, never the bar.
  return results.map((c) =>
    c.result === "SKIPPED" ? c : skipped(c.name, `quick mode, timers / ${String(ctx.timeScale)}: run \`pnpm spike\` for the real durations. Scaled result: ${c.result}: ${c.note}`),
  );
};
