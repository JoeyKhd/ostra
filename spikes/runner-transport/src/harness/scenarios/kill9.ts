import { sleep } from "../../shared/stats.ts";
import {
  commandResult,
  dispatch,
  metrics,
  presenceOf,
  restartReplica,
  restartRunner,
  runner,
  steer,
  stopSession,
  verifySession,
  waitDrained,
  waitWelcome,
  type Ctx,
  type Replica,
} from "../cluster.ts";
import { tcpProxy } from "../net-proxies.ts";
import { check, type Check } from "../report.ts";
import { describeVerify } from "./common.ts";

/**
 * Criterion 2, the kill -9 half: kill the runner mid-stream (twice), then the
 * replica holding it; every event must be stored exactly once. Also: a runner
 * killed between starting and finishing a steer reports `outcome-unknown`.
 */
export const kill9 = async (ctx: Ctx, replicas: readonly Replica[]): Promise<Check[]> => {
  const checks: Check[] = [];
  const lb = await tcpProxy(() => replicas.map((r) => ({ host: "127.0.0.1", port: r.port })));
  const url = `https://localhost:${String(lb.port)}`;
  try {
    // --- the runner, then the replica ---
    const r = runner(ctx, { id: "k9-runner", serverUrl: url, args: ["--events-per-sec=50"] });
    if ((await waitWelcome(r.child, 20_000)) === undefined) return [check("kill -9", false, "no welcome")];
    const d = await dispatch(ctx, r.id, "k9");
    await r.child.waitFor((l) => l["t"] === "dispatch-accepted", 20_000);
    let kills = 0;
    for (let i = 0; i < 2; i += 1) {
      await sleep(2_500);
      await r.child.kill9();
      kills += 1;
      await sleep(500);
      restartRunner(r);
      if ((await waitWelcome(r.child, 30_000)) === undefined) return [check("kill -9 of the runner", false, "no welcome after restart")];
    }
    await sleep(2_500);
    const holder = await presenceOf(ctx, r.id);
    const victim = replicas.find((x) => x.name === holder?.replica);
    let replicaKilled = false;
    if (victim !== undefined) {
      const from = r.child.lines.length;
      await victim.child.kill9();
      replicaKilled = true;
      const w = await waitWelcome(r.child, 120_000, from);
      if (w === undefined) checks.push(check("kill -9 of the replica holding the runner", false, "runner never reconnected"));
      await restartReplica(ctx, victim);
    }
    await sleep(2_500);
    await stopSession(ctx, r.id, d.session);
    const last = await waitDrained(r.child, d.session, 60_000);
    const v = last === undefined ? undefined : await verifySession(ctx, d.session, last);
    const m = await Promise.all(replicas.map((x) => metrics(ctx, x.port)));
    const dup = m.reduce((a, x) => a + (x?.counters.eventsDuplicate ?? 0), 0);
    checks.push(
      check(
        `kill -9 of the runner (${String(kills)}x, restarted from its spool) and of the replica holding it`,
        v?.ok === true && replicaKilled,
        `${describeVerify(v)}; ${String(dup)} replayed events skipped as duplicates by the surviving replicas`,
        { verify: v, duplicatesSkipped: dup },
      ),
    );
    await r.child.kill9();

    // --- outcome-unknown: killed mid-steer ---
    const c = runner(ctx, { id: "k9-crash", serverUrl: url, testHooks: true, args: ["--events-per-sec=10", "--crash-on-steer=true"] });
    await waitWelcome(c.child, 20_000);
    const d2 = await dispatch(ctx, c.id, "k9-crash");
    await c.child.waitFor((l) => l["t"] === "dispatch-accepted", 20_000);
    await sleep(1_000);
    const s = await steer(ctx, c.id, d2.session, { notify: true });
    await c.child.exited;
    restartRunner(c, ["--crash-on-steer=false"]);
    await c.child.waitFor((l) => l["t"] === "outcome-unknown", 20_000);
    await waitWelcome(c.child, 30_000);
    await sleep(1_500);
    const res = await commandResult(ctx, s.id);
    await stopSession(ctx, c.id, d2.session);
    const last2 = await waitDrained(c.child, d2.session, 60_000);
    const v2 = last2 === undefined ? undefined : await verifySession(ctx, d2.session, last2);
    checks.push(
      check(
        "a runner killed between starting and finishing a steer reports outcome-unknown [not the bar]",
        res?.result === "outcome-unknown" && v2?.ok === true,
        `steer result: ${res?.result ?? "none"}; ${describeVerify(v2)}`,
      ),
    );
    await c.child.kill9();
  } finally {
    await lb.close();
  }
  return checks;
};
