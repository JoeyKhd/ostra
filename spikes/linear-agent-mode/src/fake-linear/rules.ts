// What the fake Linear believes about agent sessions. These are the rules in Linear's agent docs
// (research/trackers.md section 1.4), written as code. They are the fake's assumptions, not Linear's behaviour:
// only a run against real Linear can say whether they hold. Each one that is a guess is marked.

export type FakeRules = {
  /** The webhook must be answered within this (wall-clock) time. Linear: 5 s. */
  readonly ackDeadlineMs: number;
  /** After `created`, an activity or a link must land within this (wall-clock) time. Linear: 10 s. */
  readonly firstActivityDeadlineMs: number;
  /** A session with no activity for this long, on the scenario clock, goes `stale`. Linear: 30 min. */
  readonly staleAfterMs: number;
};

export const LINEAR_RULES: FakeRules = {
  ackDeadlineMs: 5_000,
  firstActivityDeadlineMs: 10_000,
  staleAfterMs: 30 * 60 * 1000,
};

export type FakeStatus = "pending" | "active" | "awaitingInput" | "complete" | "error" | "stale" | "stopping";

export type TouchType = "thought" | "action" | "response" | "error" | "elicitation" | "prompt" | "update";

export type Touch = { readonly type: TouchType; readonly signal: string | null };

/** The status the last touch implies, before any staleness. Linear derives status from the last activity. */
export const baseStatus = (last: Touch | undefined): FakeStatus => {
  if (last === undefined) return "pending";
  switch (last.type) {
    case "thought":
    case "action":
    case "update":
      return "active";
    case "elicitation":
      return "awaitingInput";
    case "response":
      return last.signal === "continue" ? "active" : "complete";
    case "error":
      return "error";
    case "prompt":
      // Guess: a follow-up leaves the session waiting for the agent until the agent answers.
      return last.signal === "stop" ? "stopping" : "pending";
    default:
      return last.type satisfies never;
  }
};

/** Guess: only sessions the agent is expected to be working on go stale. A finished or waiting one stays as it is. */
export const goesStale = (status: FakeStatus): boolean => status === "active" || status === "pending";

export const deriveStatus = (
  last: Touch | undefined,
  lastAt: number,
  now: number,
  rules: FakeRules,
): FakeStatus => {
  const base = baseStatus(last);
  return goesStale(base) && now - lastAt > rules.staleAfterMs ? "stale" : base;
};
