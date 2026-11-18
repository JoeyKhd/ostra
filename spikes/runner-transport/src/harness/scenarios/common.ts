import { sleep } from "../../shared/stats.ts";
import {
  commandResult,
  dispatch,
  steer,
  steerReceipts,
  stopSession,
  verifySession,
  waitDrained,
  type Ctx,
  type Dispatched,
  type RunnerProc,
  type Verify,
} from "../cluster.ts";

export type StreamResult = {
  readonly dispatched: Dispatched;
  readonly accepted: boolean;
  readonly steerReceived: boolean;
  readonly steerResult: string | null;
  readonly drainedLastSeq: number | undefined;
  readonly verify: Verify | undefined;
};

/** Dispatch a session, let it stream, steer it once, stop it, drain it and check every event. */
export const streamOnce = async (ctx: Ctx, r: RunnerProc, name: string, streamMs: number): Promise<StreamResult> => {
  const d = await dispatch(ctx, r.id, name);
  const acc = await r.child.waitFor((l) => l["t"] === "dispatch-accepted" && l["session"] === d.session, 30_000);
  await sleep(streamMs);
  const s = await steer(ctx, r.id, d.session, { notify: true });
  const deadline = Date.now() + 30_000;
  while (!steerReceipts(r.child).has(s.id) && Date.now() < deadline) await sleep(100);
  await sleep(300);
  await stopSession(ctx, r.id, d.session);
  const last = await waitDrained(r.child, d.session, 60_000);
  const verify = last === undefined ? undefined : await verifySession(ctx, d.session, last);
  const res = await commandResult(ctx, s.id);
  return {
    dispatched: d,
    accepted: acc !== undefined,
    steerReceived: steerReceipts(r.child).has(s.id),
    steerResult: res?.result ?? null,
    drainedLastSeq: last,
    verify,
  };
};

export const describeVerify = (v: Verify | undefined): string =>
  v === undefined
    ? "spool never drained"
    : `${String(v.stored)}/${String(v.expected)} stored, ${String(v.duplicates)} duplicates, ${String(v.gaps)} missing, ${String(v.badBodies)} bad bodies`;

export const ms = (n: number): string => `${String(Math.round(n))} ms`;
export const secs = (n: number): string => `${(n / 1000).toFixed(1)} s`;
