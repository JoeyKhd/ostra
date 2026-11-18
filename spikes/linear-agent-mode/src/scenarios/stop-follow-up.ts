import { setTimeout as delay } from "node:timers/promises";
import { realClock } from "../clock.ts";
import type { AgentSessionId } from "../ids.ts";
import { createSilentDriver } from "../turn-driver.ts";
import { formatMs, until } from "../util.ts";
import { createRig, guarded } from "./common.ts";
import type { Rig, ScenarioReport } from "./common.ts";

const FOLLOW_UP_TEXT = "Please also add a regression test for the retry path.";

const agentActivities = (rig: Rig, id: AgentSessionId) =>
  (rig.fake.session(id)?.activities ?? []).filter((a) => a.type !== "prompt");

export const runStopFollowUpScenario = (): Promise<ScenarioReport> =>
  guarded("stop-follow-up", async (r) => {
    // The turn is silent for a minute (real time) unless stopped. A short heartbeat makes "no heartbeat after a
    // stop" something the scenario can see within a second, instead of after twenty minutes.
    const driver = createSilentDriver({ clock: realClock, durationMs: 60_000 });
    const rig = await createRig({ driver, heartbeat: { kind: "ephemeral-thought", intervalMs: 120 } });
    try {
      await rig.install();
      const { sessionId } = await rig.fake.delegate();
      await until(() => rig.server.service.stateOf(sessionId)?.kind === "working", { timeoutMs: 5_000 });
      r.check("the delegated session has a running turn", rig.server.service.stateOf(sessionId)?.kind === "working");

      // --- follow-up while the turn runs -------------------------------------------------------
      const followUpSentAt = performance.now();
      const followUp = await rig.fake.prompt(sessionId, FOLLOW_UP_TEXT);
      r.check("the follow-up webhook was delivered", followUp.delivered, `ack ${formatMs(followUp.ackMs ?? Number.NaN)}`);
      await until(() => driver.followUps.length === 1, { timeoutMs: 5_000 });
      r.check("the follow-up reached the running turn, word for word", driver.followUps[0]?.text === FOLLOW_UP_TEXT);
      const thoughtAfter = await until(() => agentActivities(rig, sessionId).some((a) => a.type === "thought" && a.body?.includes("follow-up") === true), { timeoutMs: 5_000 });
      r.check("and was answered in the session with a thought", thoughtAfter, `${formatMs(performance.now() - followUpSentAt)} after it was sent`);
      r.check("the turn kept running", rig.server.service.stateOf(sessionId)?.kind === "working");

      // --- the heartbeat is alive before the stop ---------------------------------------------
      await delay(400);
      const beating = agentActivities(rig, sessionId).filter((a) => a.ephemeral).length;
      r.check("heartbeats are flowing while the turn is silent (sanity for the check below)", beating >= 2, `${String(beating)} ephemeral thoughts so far`);

      // --- stop --------------------------------------------------------------------------------
      const stopSentAt = performance.now();
      const stop = await rig.fake.prompt(sessionId, "stop", { stop: true });
      r.check("the stop webhook was delivered", stop.delivered);
      const finalLanded = await until(() => rig.fake.session(sessionId)?.status === "complete", { timeoutMs: 5_000 });
      r.check("a stop ends in a final response", finalLanded && agentActivities(rig, sessionId).at(-1)?.type === "response", `${formatMs(performance.now() - stopSentAt)} after it was sent`);
      await rig.server.service.idle();
      const settled = agentActivities(rig, sessionId).length;
      r.check("the turn was stopped, once", driver.stops.length === 1);
      r.check("ostra's own state is ended (stopped)", JSON.stringify(rig.server.service.stateOf(sessionId)) === JSON.stringify({ kind: "ended", reason: "stopped" }));
      await delay(500);
      r.check(
        "nothing was posted after the final response, so the heartbeat stopped with the turn",
        agentActivities(rig, sessionId).length === settled,
        `${String(agentActivities(rig, sessionId).length - settled)} late activities`,
      );
      r.check("Linear saw no activity it forbids after a stop", (rig.fake.session(sessionId)?.violations.length ?? 1) === 0, rig.fake.session(sessionId)?.violations.join("; ") ?? "");

      // --- follow-up on a stopped session reopens it ------------------------------------------
      await rig.fake.prompt(sessionId, "Actually, carry on.");
      const reopened = await until(() => driver.starts.length === 2 && rig.server.service.stateOf(sessionId)?.kind === "working", { timeoutMs: 5_000 });
      r.check("a follow-up on a stopped session reopens it (a second turn starts)", reopened && driver.starts[1]?.request.reason === "follow-up");
      r.check("and the new turn starts from the follow-up's text", driver.followUps.some((f) => f.sessionId === sessionId && f.text === "Actually, carry on."));
      await rig.fake.prompt(sessionId, "stop", { stop: true });
      await until(() => rig.server.service.stateOf(sessionId)?.kind === "ended", { timeoutMs: 5_000 });

      // --- stop straight after delegating ------------------------------------------------------
      const quick = await rig.fake.delegate();
      await rig.fake.prompt(quick.sessionId, "stop", { stop: true });
      await until(() => rig.fake.session(quick.sessionId)?.status === "complete", { timeoutMs: 5_000 });
      await rig.server.service.idle();
      const quickView = rig.fake.session(quick.sessionId);
      r.check("a stop sent right after the delegation still ends the session with a final response", quickView?.status === "complete" && quickView.activities.at(-1)?.type === "response");
      r.check(
        "and nothing was posted after that final response",
        (quickView?.violations ?? []).every((v) => !v.includes("after the final response")),
        `${String(quickView?.violations.length ?? 0)} before it (a race only a script can win: the stop arrives while the first activity is still in flight)`,
      );
      const quickStarts = driver.starts.filter((s) => s.request.sessionId === quick.sessionId).length;
      const quickStops = driver.stops.filter((id) => id === quick.sessionId).length;
      r.check("every turn started for it was stopped, and none is left running", quickStarts === quickStops && rig.server.service.stateOf(quick.sessionId)?.kind === "ended", `${String(quickStarts)} started, ${String(quickStops)} stopped`);

      // --- sessions ostra has no record of (a restart, or another replica) --------------------
      const orphanStop = rig.fake.seedSession();
      await rig.fake.prompt(orphanStop.sessionId, "stop", { stop: true });
      const orphanDone = await until(() => rig.fake.session(orphanStop.sessionId)?.status === "complete", { timeoutMs: 5_000 });
      r.check("a stop for a session this process never saw still gets its final response", orphanDone);
      const orphanFollow = rig.fake.seedSession();
      const startsBefore = driver.starts.length;
      await rig.fake.prompt(orphanFollow.sessionId, "Pick this up again.");
      const orphanReopened = await until(() => driver.starts.length === startsBefore + 1, { timeoutMs: 5_000 });
      r.check("a follow-up for such a session starts a turn", orphanReopened);

      // --- the timing records the real run reads: one per accepted webhook, keyed by session -------
      await rig.server.service.idle();
      const timings = rig.server.stats().timings;
      const created = timings.filter((t) => t.kind === "created");
      r.check(
        "ack and transit are recorded per session: one 'created' record for each delegated session, with follow-ups and stops kept apart from them",
        created.length === 2 && new Set(created.map((t) => t.sessionId)).size === 2 && created.some((t) => t.sessionId === sessionId) && created.some((t) => t.sessionId === quick.sessionId) && timings.some((t) => t.kind === "prompted"),
        `${String(created.length)} created, ${String(timings.length - created.length)} prompted`,
      );
      r.check("and every accepted webhook's ack was flushed and timed", timings.every((t) => t.ackMs !== null));
    } finally {
      await rig.close();
    }
    r.note("The stop signal is delivered as a `prompted` webhook whose activity carries signal=stop, per Linear's signals page. Whether Linear's own UI sends exactly that is untested here, and the fake emits the shape the spike assumed.");
    r.note("A stop that reaches a different replica than the one running the turn is not covered. The 'session this process never saw' check above shows only that the final response is posted; it cannot stop a turn running in another process, because a session's state is a per-process Map here. That needs the turn's state in Postgres (spike 6, milestone 1).");
  });
