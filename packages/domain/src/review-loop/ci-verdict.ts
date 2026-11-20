import type { CiCheckRun, CiConclusion, CiResults } from "@ostra/adapter-sdk";

import type { CiVerdictName } from "../lifecycles/m6.ts";

// CI's verdict on a PR's head (F-035, ADR 0058, Q222): the head's check runs and commit statuses,
// with ostra's own App's check runs left out (the independent-review check would otherwise keep CI
// pending until someone approves). Pure: the clock and the push time are the caller's.

/** `OSTRA_CI_NONE_SECONDS` and `OSTRA_CI_WAIT_MINUTES`, in ms. */
export type CiWaits = { readonly noneMs: number; readonly waitMs: number };

/** The working values: no CI after 2 minutes, a 60-minute wait. */
export const DEFAULT_CI_WAITS: CiWaits = { noneMs: 120_000, waitMs: 3_600_000 };

export type CiVerdict = "pending" | CiVerdictName;

/** The conclusions that fail CI. A run that couldn't start is a failure too: nothing ran. */
const FAILING: ReadonlySet<CiConclusion> = new Set<CiConclusion>(["failure", "timed_out", "action_required", "startup_failure"]);

const others = (results: CiResults, ownAppSlug: string | null): readonly CiCheckRun[] =>
  results.checkRuns.filter((run) => ownAppSlug === null || run.appSlug !== ownAppSlug);

/**
 * `failed` when any check run concluded failing or any status is `failure` or `error`; `passed`
 * when everything finished otherwise; `none` when nothing appeared within the none wait of the push;
 * `timed_out` when something is still pending after the wait; `pending` before that.
 */
export const ciVerdict = (results: CiResults, ownAppSlug: string | null, now: number, pushedAt: number, waits: CiWaits = DEFAULT_CI_WAITS): CiVerdict => {
  const runs = others(results, ownAppSlug);
  const failed =
    runs.some((run) => run.status === "completed" && run.conclusion !== null && FAILING.has(run.conclusion)) ||
    results.statuses.some((status) => status.state === "failure" || status.state === "error");
  if (failed) {
    return "failed";
  }
  const elapsed = now - pushedAt;
  if (runs.length === 0 && results.statuses.length === 0) {
    return elapsed >= waits.noneMs ? "none" : "pending";
  }
  const pending = runs.some((run) => run.status !== "completed") || results.statuses.some((status) => status.state === "pending");
  if (pending) {
    return elapsed >= waits.waitMs ? "timed_out" : "pending";
  }
  return "passed";
};

/** A failing check, as the round's prompt and `ci.updated` name it. */
export type FailingCheck =
  | { readonly kind: "check-run"; readonly id: string; readonly name: string; readonly conclusion: CiConclusion }
  | { readonly kind: "status"; readonly context: string; readonly state: "failure" | "error" };

/** The failing checks, check runs first, at most `max` (`OSTRA_CI_LOG_CHECKS`): the ones whose logs reach the agent. */
export const failingChecks = (results: CiResults, ownAppSlug: string | null, max: number): readonly FailingCheck[] => {
  const failing: FailingCheck[] = [];
  for (const run of others(results, ownAppSlug)) {
    if (run.status === "completed" && run.conclusion !== null && FAILING.has(run.conclusion)) {
      failing.push({ kind: "check-run", id: run.id, name: run.name, conclusion: run.conclusion });
    }
  }
  for (const status of results.statuses) {
    if (status.state === "failure" || status.state === "error") {
      failing.push({ kind: "status", context: status.context, state: status.state });
    }
  }
  return failing.slice(0, max);
};
