import { sleep } from "../../shared/stats.ts";
import { dispatch, metrics, runner, startReplica, stopSession, verifySession, waitDrained, waitWelcome, type Ctx } from "../cluster.ts";
import { check, type Check } from "../report.ts";
import { describeVerify } from "./common.ts";

const LOSSES = 3;

/**
 * Criterion 2, the replay half of "exactly once": a replica (started with the
 * --lose-acks test hook) commits a batch and then drops the connection before
 * its ack leaves. The runner must resend from its spool, the server must skip
 * what it already holds, and every event must still be stored exactly once.
 */
export const lostAcks = async (ctx: Ctx): Promise<Check[]> => {
  const rep = await startReplica(ctx, "e", { loseAcks: LOSSES });
  const checks: Check[] = [];
  try {
    for (const transport of ["websocket", "http"] as const) {
      const id = `acks-${transport}`;
      const name = `a batch committed but its ack lost (${String(LOSSES)}x, over ${transport}): the replay is skipped, every event stored exactly once`;
      const before = await metrics(ctx, rep.port);
      const r = runner(ctx, { id, serverUrl: `https://localhost:${String(rep.port)}`, args: ["--events-per-sec=50", `--transport=${transport}`] });
      try {
        if ((await waitWelcome(r.child, 20_000)) === undefined) {
          checks.push(check(name, false, "no welcome"));
          continue;
        }
        const d = await dispatch(ctx, r.id, id);
        await r.child.waitFor((l) => l["t"] === "dispatch-accepted", 20_000);
        const lostLines = (): number => rep.child.lines.filter((l) => l["t"] === "test-ack-lost" && l["runner"] === id).length;
        const until = Date.now() + 120_000;
        while (lostLines() < LOSSES && Date.now() < until) await sleep(500);
        await sleep(3_000);
        await stopSession(ctx, r.id, d.session);
        const last = await waitDrained(r.child, d.session, 60_000);
        const v = last === undefined ? undefined : await verifySession(ctx, d.session, last);
        const after = await metrics(ctx, rep.port);
        const dup = (after?.counters.eventsDuplicate ?? 0) - (before?.counters.eventsDuplicate ?? 0);
        const reconnects = r.child.lines.filter((l) => l["t"] === "welcome").length - 1;
        const fellBack = r.child.lines.some((l) => l["t"] === "fallback-http");
        checks.push(
          check(
            name,
            v?.ok === true && lostLines() === LOSSES && dup > 0 && !fellBack,
            `${String(lostLines())} acks lost after commit; the runner reconnected ${String(reconnects)}x${fellBack ? " (and fell back to HTTP)" : ""}; the server skipped ${String(dup)} replayed events as already stored; ${describeVerify(v)}`,
            { verify: v, lost: lostLines(), duplicatesSkipped: dup, reconnects },
          ),
        );
      } finally {
        await r.child.kill9();
      }
    }
  } finally {
    await rep.child.kill9();
  }
  return checks;
};
