import type { ConnectionId } from "@ostra/protocol";

import { judgeDelegations, judgeFollowUp, judgeInstall, judgeKeepAlive, judgeRejected, judgeStop, pollIntervalMs, SILENT_TURN_MINUTES } from "./judge.ts";
import type { Check, DelegationSample, InstallFacts, StopFacts } from "./judge.ts";
import { createDelegatedIssue, mentionApp, readSessionStatus, replyInThread } from "./linear-api.ts";
import type { DelegatedIssue, LinearAccess } from "./linear-api.ts";
import { endOf, followUpReachedTask, matchKeyUser, readSessions, rejectAll, runnersOnline, sessionDeliveries } from "./ostra-side.ts";
import type { OstraWorld, SessionRead } from "./ostra-side.ts";

// Spike 5's four real-Linear bullets (`spikes/linear-agent-mode/src/real-run.ts`), as phases of
// ticket 38's harness, run against ostra itself: what Linear sends goes to core's inbox through the
// tunnel (or straight from the fake Linear in a rehearsal), and everything judged is read from the
// rows core wrote and from Linear's own answers. The live run and the rehearsal differ only in the
// context: which Linear, who presses "Send stop request", how the silent turn runs, and how fast
// Linear's clock goes (the fake's is sped up for the 35 minutes; real Linear's is the wall clock).

export type PhaseContext = {
  readonly world: OstraWorld;
  readonly connectionId: ConnectionId;
  readonly access: LinearAccess;
  readonly appUserId: string;
  /** The key user's address in Linear: phase 3 gives it to a project member. */
  readonly keyUserEmail: string;
  readonly delegations: number;
  readonly note: (line: string) => void;
  /** The tickets the run made, for the archive at the end. */
  readonly made: string[];
  /** How a person's "Send stop request" is had: asked for (live), or pressed by a script (rehearsal). */
  readonly pressStop: (input: { readonly identifier: string; readonly externalSessionId: string }) => Promise<void>;
  /** How long to wait for that press. */
  readonly stopWaitMs: number;
  /**
   * The follow-up's and the stop's tickets: the stub model's script for a turn that runs a few
   * minutes, with a runner online (live); or nothing, and no runner, so their tasks wait queued (the
   * rehearsal), where the follow-up can't reach a turn.
   */
  readonly workingTurn: { readonly description: string; readonly runner: boolean };
  readonly silentTurn: {
    /** The silent ticket's description: the stub model's script for a 35-minute turn of tool calls (live), or nothing. */
    readonly description: string;
    /** Linear's clock since `startedAt` (ms of the wall clock), in ms: the wall clock live, sped up in a rehearsal. */
    readonly linearElapsed: (startedAt: number) => number;
    /** A wall-clock wait that lasts `linearMs` of Linear's clock. */
    readonly wait: (linearMs: number) => Promise<void>;
    /** Ends the turn after 35 minutes, and waits until the task has: it ends by itself (live), or a member stops it in the panel. */
    readonly end: (taskId: string) => Promise<void>;
  };
};

export type BulletResult = { readonly bullet: string; readonly checks: readonly Check[] };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `read` until it gives a value, or gives `null` after `timeoutMs`. */
const until = async <T,>(read: () => Promise<T | null>, timeoutMs: number, everyMs = 500): Promise<T | null> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
};

const report = (context: PhaseContext, bullet: string, checks: readonly Check[]): BulletResult => {
  context.note(`---- ${bullet}`);
  for (const one of checks) context.note(`${one.outcome === "pass" ? "PASS" : one.outcome === "fail" ? "FAIL" : "NOT RUN"} ${one.name}: ${one.detail}`);
  return { bullet, checks };
};

const delegate = async (context: PhaseContext, title: string, description = ""): Promise<DelegatedIssue> => {
  const issue = await createDelegatedIssue(context.access, { title, description, delegateId: context.appUserId });
  context.made.push(issue.issueId);
  return issue;
};

/** ostra's sessions for these tickets, once each has `ready` true; `null` while one hasn't. */
const sessionsFor = async (context: PhaseContext, issues: readonly DelegatedIssue[], ready: (session: SessionRead) => boolean): Promise<readonly SessionRead[] | null> => {
  const sessions = await readSessions(context.world.db, context.connectionId);
  const mine = issues.map((issue) => sessions.find((session) => session.issueId === issue.issueId));
  return mine.every((session) => session !== undefined && ready(session)) ? mine.flatMap((session) => (session === undefined ? [] : [session])) : null;
};

// ---------- 1. the install ----------

export const installPhase = (context: PhaseContext, facts: InstallFacts): BulletResult => report(context, "[1] The install: the app's own user, with the agent scopes", judgeInstall(facts));

// ---------- 2. fifty delegations, then one bulk reject ----------

export const delegationsPhase = async (context: PhaseContext): Promise<BulletResult> => {
  const online = await runnersOnline(context.world);
  const issues: DelegatedIssue[] = [];
  for (let index = 0; index < context.delegations; index += 1) {
    issues.push(await delegate(context, `ostra agent-mode harness: delegation ${String(index + 1)} of ${String(context.delegations)}`));
    await sleep(250);
  }
  context.note(`${String(issues.length)} tickets created with delegateId, 250 ms apart, by the key's user; waiting for ostra's first thoughts`);
  const sessions = (await until(() => sessionsFor(context, issues, (session) => session.ackedAt !== null && session.firstThoughtAt !== null), 3 * 60_000)) ?? (await readSessions(context.world.db, context.connectionId)).filter((session) => issues.some((issue) => issue.issueId === session.issueId));
  const statuses = await Promise.all(sessions.map((session) => readSessionStatus(context.access, session.externalSessionId)));
  const samples: DelegationSample[] = sessions.map((session, index) => ({
    createdAt: issues.find((issue) => issue.issueId === session.issueId)?.answeredAt ?? 0,
    ackedAt: session.ackedAt,
    firstThoughtAt: session.firstThoughtAt,
    linearStatus: statuses[index] ?? "unreadable",
  }));
  const checks = [...judgeDelegations({ expected: context.delegations, samples, runnersOnline: Math.max(online, await runnersOnline(context.world)) })];

  // One bulk reject: every outside task waiting for approval, at once.
  const waiting = sessions.flatMap((session) => (session.taskId === null || session.matched ? [] : [session.taskId]));
  const rejected = await rejectAll(context.world, waiting);
  context.note(`one bulk reject: ${String(rejected)} of ${String(waiting.length)} outside tasks rejected`);
  const ended = (await until(() => sessionsFor(context, issues, (session) => session.state === "ended" && endOf(session).finalResponses >= 1), 3 * 60_000)) ?? [];
  await sleep(5_000);
  const settled = (await sessionsFor(context, issues, () => true)) ?? ended;
  checks.push(...judgeRejected(settled.map(endOf), context.delegations));
  return report(context, `[2] ${String(context.delegations)} delegations: each 200 under 5 s, each first thought under 10 s after it, no runner; then one bulk reject`, checks);
};

// ---------- 3. a follow-up, and a person's stop ----------

export const followUpAndStopPhase = async (context: PhaseContext): Promise<readonly BulletResult[]> => {
  // From now on the key's user is a member who can open the project: their delegations start their own tasks.
  await matchKeyUser(context.world, context.keyUserEmail);
  // The follow-up's session starts from a mention, so it has a thread to reply in.
  const follow = await createDelegatedIssue(context.access, { title: "ostra agent-mode harness: follow-up", description: context.workingTurn.description, delegateId: null });
  context.made.push(follow.issueId);
  await mentionApp(context.access, follow.issueId, context.appUserId);
  const stop = await delegate(context, "ostra agent-mode harness: stop", context.workingTurn.description);
  const started = await until(() => sessionsFor(context, [follow, stop], (session) => session.taskId !== null && session.matched), 2 * 60_000);
  const followSession = started?.[0];
  const stopSession = started?.[1];
  if (followSession === undefined || stopSession === undefined || followSession.taskId === null || stopSession.taskId === null) {
    const missing: Check = { name: "the two delegations started the member's tasks", outcome: "fail", detail: "no task for one of them" };
    return [report(context, "[3a] A follow-up from Linear", [missing]), report(context, "[3b] A person's stop", [missing])];
  }
  const followTask = followSession.taskId;
  // With a runner, the follow-up comes while the turn runs, as a person's would.
  if (context.workingTurn.runner) {
    await until(async () => ((await context.world.db.task.findUnique({ where: { id: followTask }, select: { state: true } }))?.state === "running" ? true : null), 5 * 60_000, 2_000);
  }
  const replied = await replyInThread(context.access, followSession.externalSessionId, "Please also add a regression test for the retry path. (ostra agent-mode harness, follow-up)");
  const prompted = await until(async () => ((await sessionDeliveries(context.world.db, context.connectionId)).some((one) => one.sid === followSession.externalSessionId && one.action === "prompted") ? true : null), 2 * 60_000);
  const reached = context.workingTurn.runner ? await until(async () => ((await followUpReachedTask(context.world.db, followTask)) ? true : null), 60_000) : null;
  const followUp = report(context, "[3a] A follow-up from Linear, as a thread reply by the key's user", judgeFollowUp({ replied, promptedSeen: prompted === true, reachedTask: context.workingTurn.runner ? reached === true : "no-turn" }));

  const stopTask = stopSession.taskId;
  await context.pressStop({ identifier: stop.identifier, externalSessionId: stopSession.externalSessionId });
  const signalled = await until(async () => (await sessionDeliveries(context.world.db, context.connectionId)).find((one) => one.sid === stopSession.externalSessionId && one.action === "prompted") ?? null, context.stopWaitMs, 2_000);
  let facts: StopFacts;
  if (signalled === null) {
    facts = { pressed: false, waitedMinutes: Math.round(context.stopWaitMs / 60_000) };
  } else {
    const endedSession = await until(() => sessionsFor(context, [stop], (session) => session.state === "ended" && endOf(session).finalResponses >= 1), 2 * 60_000);
    // Anything ostra posted after its final response would show by now.
    await sleep(10_000);
    const last = (await sessionsFor(context, [stop], () => true))?.[0] ?? endedSession?.[0];
    const task = await context.world.db.task.findUnique({ where: { id: stopTask }, select: { state: true } });
    const end = last === undefined ? { finalResponses: 0, postsAfterFinal: 0, ended: false } : endOf(last);
    facts = { pressed: true, signalStop: signalled.signal === "stop", turnStopped: task?.state === "stopped", finalResponses: end.finalResponses, postsAfterFinal: end.postsAfterFinal, taskState: task?.state ?? "missing" };
  }
  return [followUp, report(context, "[3b] A person's stop: Send stop request in Linear", judgeStop(facts))];
};

// ---------- 4. thirty-five silent minutes ----------

export const silentTurnPhase = async (context: PhaseContext): Promise<BulletResult> => {
  const probe = await delegate(context, "ostra agent-mode harness: 35 silent minutes", context.silentTurn.description);
  const [session] = (await until(() => sessionsFor(context, [probe], (one) => one.taskId !== null && one.firstThoughtAt !== null), 2 * 60_000)) ?? [];
  if (session === undefined || session.taskId === null || session.firstThoughtAt === null) {
    return report(context, `[4] A silent turn of ${String(SILENT_TURN_MINUTES)} minutes stays alive`, [{ name: "the silent ticket started its task", outcome: "fail", detail: "no task or first thought" }]);
  }
  const startedAt = session.firstThoughtAt;
  context.note(`watching ${probe.identifier}'s session for ${String(SILENT_TURN_MINUTES)} minutes: its status every minute, every 10 s from minute 28`);
  const polls: { atMs: number; status: string }[] = [];
  for (;;) {
    const atMs = context.silentTurn.linearElapsed(startedAt);
    if (atMs >= SILENT_TURN_MINUTES * 60_000) break;
    polls.push({ atMs, status: await readSessionStatus(context.access, session.externalSessionId) });
    await context.silentTurn.wait(Math.min(pollIntervalMs(atMs), SILENT_TURN_MINUTES * 60_000 - atMs));
  }
  const elapsedMs = context.silentTurn.linearElapsed(startedAt);
  const during = (await sessionsFor(context, [probe], () => true))?.[0] ?? session;
  const posts = during.activities
    .filter((activity) => activity.createdAt > startedAt && activity.kind !== "response")
    .map((activity) => ({ atMs: activity.createdAt - startedAt, kind: activity.heartbeat ? ("heartbeat" as const) : ("other" as const) }));
  await context.silentTurn.end(session.taskId);
  const finalStatus = (await until(async () => {
    const status = await readSessionStatus(context.access, session.externalSessionId);
    return status === "complete" ? status : null;
  }, 2 * 60_000, 2_000)) ?? (await readSessionStatus(context.access, session.externalSessionId));
  return report(context, `[4] A silent turn of ${String(SILENT_TURN_MINUTES)} minutes stays alive`, judgeKeepAlive({ polls, posts, elapsedMs, finalStatus }));
};
