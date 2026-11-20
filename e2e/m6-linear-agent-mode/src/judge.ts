// The pass bars of spike 5's four real-Linear bullets (ticket 38, F-012, ADR 0013), in one place:
// ported from `spikes/linear-agent-mode/src/scenarios/evaluate.ts`, so the live run and its rehearsal
// on the fake Linear are judged by the same code. Every sample is a time on this machine's clock at
// both ends (the create call's answer, core's 200, the first thought's post), so no clock skew enters
// it, unlike the spike's run, whose end-to-end figure was inconclusive for that reason.

export const ACK_LIMIT_MS = 5_000;
export const FIRST_THOUGHT_LIMIT_MS = 10_000;
/** Linear marks a session stale after 30 minutes with no activity (spike 5). */
export const STALE_LIMIT_MS = 30 * 60_000;
export const SILENT_TURN_MINUTES = 35;
/** A stale episode can last under a minute, so from minute 28 the watch polls every 10 s. */
export const FAST_POLL_FROM_MINUTE = 28;
/** How long the harness waits for a person to press "Send stop request". */
export const STOP_WAIT_MINUTES = 30;

/** A check's outcome. `not-run` is a bullet the run couldn't do (no person pressed stop): never a pass. */
export type Outcome = "pass" | "fail" | "not-run";
export type Check = { readonly name: string; readonly outcome: Outcome; readonly detail: string };

const check = (name: string, ok: boolean, detail: string): Check => ({ name, outcome: ok ? "pass" : "fail", detail });

export const bulletOutcome = (checks: readonly Check[]): Outcome =>
  checks.some((one) => one.outcome === "fail") ? "fail" : checks.some((one) => one.outcome === "not-run") || checks.length === 0 ? "not-run" : "pass";

const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

export type Summary = { readonly p50: number; readonly p95: number; readonly max: number };
export const summarize = (values: readonly number[]): Summary => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  return { p50: at(50), p95: at(95), max: sorted.at(-1) ?? 0 };
};
const describe = (summary: Summary): string => `p50 ${seconds(summary.p50)}, p95 ${seconds(summary.p95)}, max ${seconds(summary.max)}`;

// ---------- 1. the install ----------

export type InstallFacts = {
  /** Linear's `viewer.app` for the app's token. */
  readonly viewerIsApp: boolean;
  readonly appUserId: string;
  /** The personal key's user: the admin who authorized. */
  readonly adminUserId: string;
  /** The scopes the token answer granted (Linear reads no scopes back). */
  readonly scopes: readonly string[];
};

export const judgeInstall = (facts: InstallFacts): readonly Check[] => [
  check("the connection's user is the app's own (viewer.app)", facts.viewerIsApp, facts.viewerIsApp ? "viewer.app is true" : "viewer.app is not true"),
  check("and a different user from the admin who authorized it", facts.appUserId !== "" && facts.appUserId !== facts.adminUserId, facts.appUserId === facts.adminUserId ? "the same user" : "two users"),
  check(
    "it holds the agent scopes",
    facts.scopes.includes("app:assignable") && facts.scopes.includes("app:mentionable"),
    `granted: ${[...facts.scopes].sort().join(", ")}`,
  ),
];

// ---------- 2. fifty delegations ----------

export type DelegationSample = {
  /** When the create call with `delegateId` answered, on this machine's clock. */
  readonly createdAt: number;
  /** When core answered the session's `created` webhook 200 (its delivery's insert), or null when it never came. */
  readonly ackedAt: number | null;
  /** When the session's first thought was posted to Linear, or null. */
  readonly firstThoughtAt: number | null;
  /** Linear's status for the session, read after all of them were in. */
  readonly linearStatus: string;
};

export const judgeDelegations = (input: {
  readonly expected: number;
  readonly samples: readonly DelegationSample[];
  /** Runners online while the delegations came in. */
  readonly runnersOnline: number;
}): readonly Check[] => {
  const { expected, samples } = input;
  const acked = samples.filter((one) => one.ackedAt !== null);
  // The webhook can come before the create call answers: that counts as no wait at all.
  const acks = acked.map((one) => Math.max(0, (one.ackedAt ?? 0) - one.createdAt));
  const firsts = samples.flatMap((one) => (one.ackedAt === null || one.firstThoughtAt === null ? [] : [one.firstThoughtAt - one.ackedAt]));
  const statuses = [...new Set(samples.map((one) => one.linearStatus))].sort();
  return [
    check(`all ${String(expected)} delegations reached ostra`, samples.length === expected && acked.length === expected, `${String(acked.length)} of ${String(expected)} answered`),
    check(`each answered 200 under ${seconds(ACK_LIMIT_MS)} after its create call returned`, acks.length === expected && summarize(acks).max < ACK_LIMIT_MS, acks.length === 0 ? "none" : describe(summarize(acks))),
    check(
      `each first thought posted under ${seconds(FIRST_THOUGHT_LIMIT_MS)} after the 200`,
      firsts.length === expected && summarize(firsts).max < FIRST_THOUGHT_LIMIT_MS,
      firsts.length === expected ? describe(summarize(firsts)) : `${String(expected - firsts.length)} without a first thought`,
    ),
    check("no runner was online", input.runnersOnline === 0, `${String(input.runnersOnline)} online`),
    check("Linear reports every session active, none stale or in error", samples.length > 0 && samples.every((one) => one.linearStatus === "active"), statuses.join(", ")),
  ];
};

export type EndedSession = { readonly finalResponses: number; readonly postsAfterFinal: number; readonly ended: boolean };

/** After one bulk reject: each session ends with one final response, and nothing after it. */
export const judgeRejected = (sessions: readonly EndedSession[], expected: number): readonly Check[] => {
  const good = sessions.filter((one) => one.ended && one.finalResponses === 1 && one.postsAfterFinal === 0).length;
  return [check("after one bulk reject, every session ended with one final response and nothing after it", sessions.length === expected && good === expected, `${String(good)} of ${String(expected)}`)];
};

// ---------- 3. follow-up and stop ----------

export type FollowUpFacts = {
  /** The thread reply was posted by the key's user. */
  readonly replied: boolean;
  /** Linear sent it to ostra as a `prompted` event. */
  readonly promptedSeen: boolean;
  /**
   * It reached the task as the matched member's message, into its running turn. `no-turn`: the run
   * had no runner, so the task waited queued, and a queued task takes no message (`not-reopenable`).
   */
  readonly reachedTask: boolean | "no-turn";
};

export type StopFacts =
  | { readonly pressed: false; readonly waitedMinutes: number }
  | {
      readonly pressed: true;
      readonly signalStop: boolean;
      readonly turnStopped: boolean;
      readonly finalResponses: number;
      readonly postsAfterFinal: number;
      readonly taskState: string;
    };

export const judgeFollowUp = (facts: FollowUpFacts): readonly Check[] => [
  check("a follow-up, as a thread reply by the key's user, came to ostra as a prompted event", facts.replied && facts.promptedSeen, facts.replied ? (facts.promptedSeen ? "prompted" : "no prompted event") : "the reply wasn't posted"),
  facts.reachedTask === "no-turn"
    ? { name: "and reached the task as the member's message", outcome: "not-run", detail: "no runner, so no running turn to take it: a queued task takes no message" }
    : check("and reached the task as the member's message", facts.reachedTask, facts.reachedTask ? "on the task" : "not on the task"),
];

export const judgeStop = (facts: StopFacts): readonly Check[] => {
  if (!facts.pressed) {
    return [{ name: "a person pressed Send stop request", outcome: "not-run", detail: `nobody pressed it in ${String(facts.waitedMinutes)} minutes: not run, so not passed` }];
  }
  return [
    check("the prompted event carried signal: stop", facts.signalStop, facts.signalStop ? "signal stop" : "no stop signal"),
    check("the turn stopped, and the task is stopped", facts.turnStopped && facts.taskState === "stopped", `task ${facts.taskState}`),
    check("ostra posted one final response and nothing after it", facts.finalResponses === 1 && facts.postsAfterFinal === 0, `${String(facts.finalResponses)} final responses, ${String(facts.postsAfterFinal)} posts after`),
  ];
};

// ---------- 4. thirty-five silent minutes ----------

/** How long the watch waits before its next poll, `elapsedMs` into the silent turn (on Linear's clock). */
export const pollIntervalMs = (elapsedMs: number): number => (elapsedMs >= FAST_POLL_FROM_MINUTE * 60_000 ? 10_000 : 60_000);

export type KeepAliveFacts = {
  /** Every status read while the turn ran, in order, with its time into the turn (Linear's clock). */
  readonly polls: readonly { readonly atMs: number; readonly status: string }[];
  /** ostra's posts to the session while it ran, in order, with their times after the first thought on this machine's clock. */
  readonly posts: readonly { readonly atMs: number; readonly kind: "heartbeat" | "other" }[];
  readonly elapsedMs: number;
  readonly finalStatus: string;
};

export const judgeKeepAlive = (facts: KeepAliveFacts): readonly Check[] => {
  const stale = facts.polls.filter((poll) => poll.status === "stale").length;
  const heartbeats = facts.posts.filter((post) => post.kind === "heartbeat").length;
  const others = facts.posts.filter((post) => post.kind === "other").length;
  // The watch never leaves more than a minute between reads, and 10 s from minute 28.
  const gaps = facts.polls.slice(1).map((poll, index) => ({ atMs: poll.atMs, gap: poll.atMs - (facts.polls[index]?.atMs ?? 0) }));
  const slowGap = gaps.find((one) => one.gap > (one.atMs > FAST_POLL_FROM_MINUTE * 60_000 + 10_000 ? 15_000 : 75_000));
  return [
    check(`the turn ran at least ${String(SILENT_TURN_MINUTES)} minutes`, facts.elapsedMs >= SILENT_TURN_MINUTES * 60_000, `${(facts.elapsedMs / 60_000).toFixed(1)} min`),
    check("the session was polled every minute, and every 10 s from minute 28", facts.polls.length > 0 && slowGap === undefined, slowGap === undefined ? `${String(facts.polls.length)} reads` : `a ${seconds(slowGap.gap)} gap at minute ${(slowGap.atMs / 60_000).toFixed(1)}`),
    check("it was never stale", stale === 0, `${String(stale)} stale reads`),
    check("a heartbeat kept it alive, and ostra posted nothing else", heartbeats >= 1 && others === 0, `${String(heartbeats)} heartbeats, ${String(others)} other posts`),
    check("it ended complete", facts.finalStatus === "complete", facts.finalStatus),
  ];
};
