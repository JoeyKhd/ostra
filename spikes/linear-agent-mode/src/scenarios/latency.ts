import { setTimeout as delay } from "node:timers/promises";
import { realClock } from "../clock.ts";
import type { AgentSessionId } from "../ids.ts";
import { createInstantDriver, createSilentDriver, createUnavailableDriver } from "../turn-driver.ts";
import type { RecordingDriver } from "../turn-driver.ts";
import { formatMs, formatSummary, summarize, until } from "../util.ts";
import { createRecorder, createRig, guarded, logText } from "./common.ts";
import type { Recorder, ScenarioReport } from "./common.ts";
import { ACK_LIMIT_MS, evaluateLatency, firstActivitySamples } from "./evaluate.ts";

// Ticket text is untrusted. These titles and descriptions carry shell syntax and a marker that must never
// come back out in a log line or in anything posted to Linear.
const hostileTitle = (i: number): string => `Fix "quoted" $(touch /tmp/pwned) \`id\` ; rm -rf / && echo SENTINEL-TICKET-${String(i)}`;
const hostileDescription = (i: number): string => `<script>alert(1)</script> | cat /etc/passwd > SECRET-DESC-TOKEN-${String(i)} ${"x".repeat(2000)}`;

type RunOptions = {
  readonly label: string;
  readonly count: number;
  /** Real milliseconds between two delegations; 0 sends them all at once. */
  readonly paceMs: number;
  readonly driver: RecordingDriver;
  readonly apiLatencyMs?: number;
  /** One failed first attempt per delegation. */
  readonly failFirstAttempt?: boolean;
  readonly expectNoRunner?: boolean;
  /** Linear answers slower than one attempt may wait, so retries overlap the first request. */
  readonly expectNoDuplicates?: boolean;
  /** Real milliseconds the durable inbox insert takes before the 200: Postgres, and the proxy in front, as one number. */
  readonly inboxDelayMs?: number;
};

const runDelegations = async (r: Recorder, options: RunOptions): Promise<void> => {
  const { label, count } = options;
  const rig = await createRig({ driver: options.driver, ...(options.inboxDelayMs === undefined ? {} : { inboxDelayMs: options.inboxDelayMs }) });
  try {
    const installed = await rig.install();
    r.check(`${label}: the app installs`, installed.kind === "installed");
    if (options.apiLatencyMs !== undefined) rig.fake.setApiLatencyMs(options.apiLatencyMs);
    if (options.failFirstAttempt === true) rig.fake.injectActivityFaults(Array.from({ length: count }, () => "http500" as const));

    const delegations: Promise<{ readonly sessionId: AgentSessionId }>[] = [];
    for (let i = 0; i < count; i += 1) {
      delegations.push(rig.fake.delegate({ title: hostileTitle(i), description: hostileDescription(i) }));
      if (options.paceMs > 0) await delay(options.paceMs);
    }
    await Promise.all(delegations);
    const allLanded = await until(() => rig.fake.sessions().every((s) => s.firstActivityMs !== null), { timeoutMs: 20_000 });
    if (options.expectNoRunner === true) {
      await until(() => rig.fake.sessions().every((s) => s.status === "error"), { timeoutMs: 10_000 });
    }
    await rig.server.service.idle();

    const sessions = rig.fake.sessions();
    evaluateLatency(r, label, count, {
      ackMs: sessions.flatMap((s) => (s.ackMs === null ? [] : [s.ackMs])),
      firstActivityMs: sessions.map((s) => s.firstActivityMs),
    });
    r.check(`${label}: Linear never showed an agent as unresponsive`, sessions.every((s) => !s.unresponsive) && allLanded);
    r.check(
      `${label}: each webhook was delivered once, on the first try`,
      sessions.every((s) => s.deliveries.every((d) => d.attempts.length === 1)),
    );
    const serverAck = summarize(rig.server.stats().timings.flatMap((t) => (t.ackMs === null ? [] : [t.ackMs])));
    r.note(`${label}: server-side ack time (request in to 200 flushed): ${formatSummary(serverAck)}`);
    if (options.inboxDelayMs !== undefined) {
      // The control for the variants below: the delay really is inside the ack, so a pass is not about a knob that is unplugged.
      r.check(
        `${label}: the inbox's ${formatMs(options.inboxDelayMs)} was inside the ack (the 200 waited for the insert)`,
        serverAck.n === count && serverAck.min >= options.inboxDelayMs * 0.95,
        `server-side ack min ${formatMs(serverAck.min)}`,
      );
    }

    const metrics = rig.server.service.metrics();
    r.check(
      `${label}: the first thought was posted before the runner was even asked`,
      metrics.length === count && metrics.every((m) => m.firstThoughtAt !== null && m.driverAskedAt !== null && m.firstThoughtAt <= m.driverAskedAt),
    );
    if (options.failFirstAttempt === true) {
      r.check(
        `${label}: a failed first attempt was retried inside the budget`,
        metrics.every((m) => m.firstActivityAttempts >= 2),
        `attempts ${formatSummary(summarize(metrics.map((m) => m.firstActivityAttempts)))}`,
      );
    }
    if (options.expectNoRunner === true) {
      r.check(
        `${label}: with no runner, each session got a first thought and then an error, and none was left hanging`,
        sessions.every((s) => s.activities.filter((a) => a.type === "thought").length === 1 && s.activities.at(-1)?.type === "error" && s.status === "error"),
      );
    }
    if (options.expectNoDuplicates === true) {
      // The first request is still in flight when its retry goes out, and both land. Wait for the late one.
      await delay(5_500);
      const after = rig.fake.sessions();
      r.check(
        `${label}: a retry overlapping a slow first request posted nothing twice`,
        after.every((s) => s.activities.filter((a) => a.type === "thought").length === 1) && after.some((s) => s.repeatedActivityIds > 0),
        `${String(after.reduce((n, s) => n + s.repeatedActivityIds, 0))} repeats answered as the original`,
      );
    }
    const dangerous = ["SENTINEL-TICKET", "SECRET-DESC-TOKEN"];
    const said = sessions.flatMap((s) => s.activities.map((a) => a.body ?? "")).join("\n");
    const logged = logText(rig.logs);
    r.check(
      `${label}: ticket text appears in no log line and in nothing posted to Linear`,
      dangerous.every((marker) => !logged.includes(marker) && !said.includes(marker)),
    );
  } finally {
    await rig.close();
  }
};

/**
 * The pass bar counts a posted thought as the first activity. Linear also counts an external-link update against its
 * "unresponsive" rule, so a session whose thought is refused but whose link lands looks fine to Linear and must still
 * not pass here. The evaluation is the one the real run uses (`firstActivitySamples`).
 */
const runThoughtRejected = async (r: Recorder): Promise<void> => {
  const count = 3;
  const rig = await createRig({ driver: createSilentDriver({ clock: realClock, durationMs: 60_000 }) });
  try {
    await rig.install();
    rig.fake.injectActivityFaults(Array.from({ length: count }, () => "rejected" as const));
    await Promise.all(Array.from({ length: count }, () => rig.fake.delegate()));
    await until(() => rig.server.service.metrics().length === count && rig.server.service.metrics().every((m) => m.driverAskedAt !== null), { timeoutMs: 20_000 });
    await rig.server.service.idle();
    const metrics = rig.server.service.metrics();
    const judged = createRecorder();
    evaluateLatency(judged, "thought refused", count, {
      ackMs: rig.server.stats().timings.flatMap((t) => (t.ackMs === null ? [] : [t.ackMs])),
      firstActivityMs: firstActivitySamples(metrics, () => 0),
    });
    const verdict = judged.report("latency").checks.find((c) => c.name.includes("first activity landed"));
    r.check(
      "thought refused: the link alone counted as Linear's first response, so the sessions were not unresponsive",
      metrics.length === count && metrics.every((m) => m.firstActivityAt !== null && m.firstActivityVia === "link") && rig.fake.sessions().every((s) => !s.unresponsive),
    );
    r.check(
      "thought refused (control): the pass bar's first-activity check still fails, because a link is not an activity",
      metrics.every((m) => m.firstThoughtAt === null) && verdict?.status === "FAIL",
      verdict?.detail ?? "no verdict",
    );
  } finally {
    await rig.close();
  }
};

type InboxProbe = { readonly inboxDelayMs: number; readonly delivered: boolean; readonly ackMs: number | null };

/** Three delegations at one inbox delay: did Linear get its 200 inside 5 s? */
const probeInbox = async (inboxDelayMs: number): Promise<InboxProbe> => {
  const rig = await createRig({ driver: createInstantDriver(), inboxDelayMs });
  try {
    await rig.install();
    const results = await Promise.all(Array.from({ length: 3 }, () => rig.fake.delegate()));
    // Past the deadline Linear has given up, but the server still finishes behind it. Let it, before closing.
    await until(() => rig.server.stats().accepted === 3, { timeoutMs: inboxDelayMs + 5_000 });
    await rig.server.service.idle();
    const acks = results.flatMap((x) => (x.delivery.ackMs === null ? [] : [x.delivery.ackMs]));
    return { inboxDelayMs, delivered: results.every((x) => x.delivery.delivered), ackMs: acks.length === 0 ? null : Math.max(...acks) };
  } finally {
    await rig.close();
  }
};

export const INBOX_HELD_MS = 4_500;
export const INBOX_BROKEN_MS = 5_200;

export const runLatencyScenario = (): Promise<ScenarioReport> =>
  guarded("latency", async (r) => {
    const silent = (): RecordingDriver => createSilentDriver({ clock: realClock, durationMs: 60_000 });
    await runDelegations(r, { label: "paced", count: 50, paceMs: 40, driver: silent() });
    await runDelegations(r, { label: "burst", count: 50, paceMs: 0, driver: silent() });
    await runDelegations(r, { label: "no runner", count: 50, paceMs: 0, driver: createUnavailableDriver("no runner is online"), expectNoRunner: true });
    await runDelegations(r, { label: "slow Linear", count: 50, paceMs: 0, driver: silent(), apiLatencyMs: 600, failFirstAttempt: true });
    await runDelegations(r, { label: "very slow Linear", count: 10, paceMs: 0, driver: silent(), apiLatencyMs: 5_000, expectNoDuplicates: true });
    await runThoughtRejected(r);
    // The ack in ostra follows a durable insert in Postgres, and travels through a proxy with TLS. Neither is here.
    // These variants stand them in with a fixed delay before the 200, to see how much of the 5 s they may use.
    await runDelegations(r, { label: "inbox 250 ms", count: 50, paceMs: 0, driver: silent(), inboxDelayMs: 250 });
    await runDelegations(r, { label: "inbox 4 s", count: 10, paceMs: 0, driver: silent(), inboxDelayMs: 4_000 });

    // Where it breaks: one probe just inside the limit and one just past it, run side by side.
    const [held, broken] = await Promise.all([probeInbox(INBOX_HELD_MS), probeInbox(INBOX_BROKEN_MS)]);
    r.check(
      `inbox probe: with a ${formatMs(held.inboxDelayMs)} insert, every webhook still got its 200 inside ${formatMs(ACK_LIMIT_MS)}`,
      held.delivered && held.ackMs !== null && held.ackMs < ACK_LIMIT_MS,
      held.ackMs === null ? "no ack" : `slowest ack ${formatMs(held.ackMs)}`,
    );
    r.check(
      `inbox probe (control): with a ${formatMs(broken.inboxDelayMs)} insert, Linear's ${formatMs(ACK_LIMIT_MS)} runs out and the webhook counts as undelivered`,
      !broken.delivered,
      broken.delivered ? "it was delivered, so the check cannot see a break" : "undelivered, as expected",
    );
    const overheadMs = held.ackMs === null ? null : Math.max(1, Math.round(held.ackMs - held.inboxDelayMs));
    r.note(
      `Where the ack breaks: with a ${formatMs(held.inboxDelayMs)} inbox insert every webhook was still answered in time, and with a ${formatMs(broken.inboxDelayMs)} one none was. The server's own part of the ack was about ${overheadMs === null ? "?" : String(overheadMs)} ms on loopback with no load. So the durable insert, the proxy and TLS share just under ${formatMs(ACK_LIMIT_MS)} between them, less whatever a loaded server adds; a Postgres on another machine, a cold connection or a slow tunnel can use it. A first delivery that misses is retried by Linear after a minute.`,
    );
    r.note("Ack time excludes the durable inbox insert and the tunnel until the real run. Except in the 'inbox' variants, the 200 here follows an in-memory Map on loopback; those variants add a fixed delay in its place, which shows how much of the 5 s a slow insert or proxy may use, not how long Postgres or a tunnel takes. The real run adds the one-way transit from Linear's own timestamp, and does not measure the 200's return leg.");
    r.note("These are the server's own times, against a fake Linear on loopback. They show the handler and the fast lane hold the limits with no runner, not that Linear's network does.");
  });
