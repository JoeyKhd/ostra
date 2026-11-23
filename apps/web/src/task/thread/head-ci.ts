import type { StoredEvent } from "@ostra/protocol";

import type { ThreadResults } from "./thread-context";
import type { HeadCi } from "./words";

// Owner: ticket 14 (milestone 10, F-151/c6). The code host's CI on any head a turn pushed: the
// repo's current head's as `tasks.get` counts it, an older head's from the log's `ci.updated`, so a
// later push's line says its own verdict (`Pushed 9a03d1e · CI passed`). Pure, so it's tested alone.

/** `ci.updated`'s state in the CI line's words: `pending` is running, a timeout a failure. */
export const ciStateOf = (state: Extract<StoredEvent["event"], { kind: "ci.updated" }>["state"]): HeadCi["state"] => {
  switch (state) {
    case "pending":
      return "running";
    case "passed":
      return "passed";
    case "failed":
    case "timed_out":
      return "failed";
    case "none":
      return "none";
    default:
      return state satisfies never;
  }
};

const isCiState = (value: string): value is HeadCi["state"] => value === "running" || value === "passed" || value === "failed" || value === "none";

/**
 * The latest verdict on each pushed head in the log, as one string (`{repoId}:{sha} passed,…`): the
 * thread keys its parts by it, so an event that changes no verdict changes nothing they read.
 */
export const headVerdictsKey = (events: readonly StoredEvent[]): string => {
  const verdicts = new Map<string, HeadCi["state"]>();
  for (const { event } of events) if (event.kind === "ci.updated") verdicts.set(`${event.repoId}:${event.headSha}`, ciStateOf(event.state));
  return [...verdicts].map(([head, state]) => `${head} ${state}`).join(",");
};

/** The verdicts a key holds, by `{repoId}:{sha}`. */
export const headVerdictsOf = (key: string): ReadonlyMap<string, HeadCi["state"]> =>
  new Map(
    key.split(",").flatMap((entry) => {
      const [head, state] = entry.split(" ");
      return head === undefined || state === undefined || !isCiState(state) ? [] : [[head, state] as const];
    }),
  );

/** The results' CI on a pushed head: the repo's head's from `tasks.get`, an older head's from the log's verdicts. */
export const withHeadCi = (results: Omit<ThreadResults, "ciOnHead">, ciOf: (repoId: string) => HeadCi | null, verdicts: ReadonlyMap<string, HeadCi["state"]>): ThreadResults => ({
  ...results,
  ciOnHead: (repoId, headSha) => (results.headOf(repoId) === headSha ? (ciOf(repoId)?.state ?? null) : (verdicts.get(`${repoId}:${headSha}`) ?? null)),
});
