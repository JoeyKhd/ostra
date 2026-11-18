import { createClock } from "../clock.ts";
import type { HeartbeatConfig } from "../agent-sessions.ts";
import type { AgentSessionId } from "../ids.ts";
import { createSilentDriver } from "../turn-driver.ts";
import { until } from "../util.ts";
import { createRig, guarded } from "./common.ts";
import type { Recorder, ScenarioReport } from "./common.ts";
import { evaluateKeepAlive } from "./evaluate.ts";

const MINUTE = 60_000;
export const SILENT_TURN_MINUTES = 35;
export const HEARTBEAT_MINUTES = 20;

type Variant = "main" | "faulty heartbeat" | "no heartbeat (control)";

type VariantResult = {
  readonly variant: Variant;
  readonly sessions: number;
  readonly completed: boolean;
  readonly elapsedVirtualMs: number;
  readonly realSeconds: number;
  readonly staleEpisodes: number;
  readonly maxGapMs: number;
  readonly finalStatuses: readonly string[];
  readonly heartbeats: readonly number[];
  readonly shape: readonly string[];
  readonly activityCreates: number;
  readonly heartbeatsPosted: number;
  readonly heartbeatsMissed: number;
  /** The final status as ostra reads it back through the API, not from the fake directly. */
  readonly apiStatuses: readonly string[];
};

const runVariant = async (variant: Variant, scale: number, sessions: number): Promise<VariantResult> => {
  const clock = createClock(scale);
  const driver = createSilentDriver({ clock, durationMs: SILENT_TURN_MINUTES * MINUTE });
  const heartbeat: HeartbeatConfig =
    variant === "no heartbeat (control)" ? { kind: "off" } : { kind: "ephemeral-thought", intervalMs: HEARTBEAT_MINUTES * MINUTE };
  const rig = await createRig({ clock, driver, heartbeat });
  try {
    const installed = await rig.install();
    if (installed.kind !== "installed") throw new Error("the app did not install");
    const startedAt = clock.now();
    const startedReal = performance.now();
    const ids: AgentSessionId[] = [];
    for (let i = 0; i < sessions; i += 1) ids.push((await rig.fake.delegate()).sessionId);
    await until(() => ids.every((id) => (rig.fake.session(id)?.firstActivityMs ?? null) !== null), { timeoutMs: 10_000 });
    if (variant === "faulty heartbeat") {
      // The next activity calls are the heartbeat's: one server error, then a rate limit, then it must get through.
      rig.fake.injectActivityFaults(["http500", "ratelimited"]);
    }
    // Real time allowed: the silent turn at this speed, plus a margin for slow machines.
    const timeoutMs = (SILENT_TURN_MINUTES * MINUTE) / scale * 1.6 + 30_000;
    const completed = await until(() => ids.every((id) => rig.fake.session(id)?.status === "complete"), { timeoutMs, pollMs: 25 });
    await rig.server.service.idle();
    const views = ids.map((id) => rig.fake.session(id));
    const present = views.flatMap((v) => (v === undefined ? [] : [v]));
    const metrics = rig.server.service.metrics();
    const api = rig.server.api(rig.fake.organizationId);
    const apiStatuses = api === undefined ? [] : await Promise.all(ids.map((id) => api.sessionStatus(id)));
    return {
      variant,
      sessions,
      completed,
      elapsedVirtualMs: clock.now() - startedAt,
      realSeconds: (performance.now() - startedReal) / 1000,
      staleEpisodes: present.reduce((sum, v) => sum + v.staleEpisodes, 0),
      maxGapMs: Math.max(...present.map((v) => v.maxGapMs)),
      finalStatuses: present.map((v) => v.status),
      heartbeats: present.map((v) => v.activities.filter((a) => a.ephemeral).length),
      shape: present.map((v) => v.activities.map((a) => (a.ephemeral ? "heartbeat" : a.type)).join(" > ")),
      activityCreates: rig.fake.apiCalls()["agentActivityCreate"] ?? 0,
      heartbeatsPosted: metrics.reduce((sum, m) => sum + m.heartbeatsPosted, 0),
      heartbeatsMissed: metrics.reduce((sum, m) => sum + m.heartbeatsMissed, 0),
      apiStatuses,
    };
  } finally {
    await rig.close();
  }
};

const judge = (r: Recorder, result: VariantResult): void => {
  const label = result.variant;
  r.check(`${label}: every session reached the end of its turn`, result.completed, result.finalStatuses.join(", "));
  const finalStatus = result.finalStatuses.every((s) => s === "complete") ? "complete" : result.finalStatuses.join("/");
  if (result.variant === "no heartbeat (control)") {
    // The control only means something if the fake can see staleness at all: with no heartbeat it must.
    r.check(
      "no heartbeat (control): the same silent turn does go stale, so the other runs' pass is not vacuous",
      result.staleEpisodes >= 1 && result.maxGapMs >= 30 * MINUTE,
      `${String(result.staleEpisodes)} stale episodes, longest silence ${(result.maxGapMs / MINUTE).toFixed(1)} min`,
    );
    return;
  }
  evaluateKeepAlive(r, label, SILENT_TURN_MINUTES * MINUTE, {
    staleEpisodes: result.staleEpisodes,
    maxGapMs: result.maxGapMs,
    elapsedMs: result.elapsedVirtualMs,
    finalStatus,
  });
  r.check(`${label}: read back through the API, every session is complete`, result.apiStatuses.length === result.sessions && result.apiStatuses.every((s) => s === "complete"), result.apiStatuses.join(", "));
  const expected = Math.floor(SILENT_TURN_MINUTES / HEARTBEAT_MINUTES);
  r.check(`${label}: each session was kept alive by ${String(expected)} heartbeat, and said nothing else`, result.heartbeats.every((h) => h === expected), `shape: ${result.shape[0] ?? ""}`);
  if (result.variant === "faulty heartbeat") {
    r.check(
      `${label}: the heartbeat got through a server error and a rate limit`,
      result.heartbeatsPosted === 1 && result.heartbeatsMissed === 0 && result.activityCreates >= 5,
      `${String(result.activityCreates)} activity calls for one first thought, one heartbeat and one response`,
    );
  }
};

export const runKeepAliveScenario = (scale: number): Promise<ScenarioReport> =>
  guarded("keep-alive", async (r) => {
    const results = await Promise.all([
      runVariant("main", scale, 3),
      runVariant("faulty heartbeat", scale, 1),
      runVariant("no heartbeat (control)", scale, 1),
    ]);
    for (const result of results) judge(r, result);
    const [main] = results;
    r.note(
      scale === 1
        ? `The ${String(SILENT_TURN_MINUTES)}-minute turn ran in real time (${(main.realSeconds / 60).toFixed(1)} min).`
        : `The ${String(SILENT_TURN_MINUTES)}-minute turn ran on a clock ${String(scale)}x faster than the wall clock (${main.realSeconds.toFixed(1)} s real). Timers, backoff and the fake's staleness rule all follow that clock; HTTP stays real. It tests the logic, not Linear. \`pnpm spike -- --only keep-alive --real-time\` runs it for 35 real minutes; no real-time run of this version has been saved.`,
    );
    r.note(
      `Cost of the keep-alive: one request per ${String(HEARTBEAT_MINUTES)} minutes per silent session, so 3 an hour. Against the 5,000 an hour a Linear app user gets (research/trackers.md 1.4), that is about 1,600 silent sessions per workspace before anything else uses the budget. Derived from the research figure, not measured.`,
    );
    r.note("The fake defines Linear's staleness rule, so 'never stale' here shows that ostra's timer posts a heartbeat, not that Linear counts it: in the fake an ephemeral thought resets the 30-minute clock because the fake says it does. What real Linear counts as activity is not known. If it does not count an ephemeral thought, the heartbeat kind switches to a plain thought (config), and only a real run can say.");
  });
