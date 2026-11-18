// The pass-bar checks that read the real runs and their rating off disk.
// Each is a plain function over what `real-sets.ts` found, so the cases that
// must never read as a pass (a trial of one run, a half-finished set, a stale
// sheet, a rate-limited run) can be tested.
//
// The rule they share: a set is judged only when it holds the bar's 30 runs
// (10 tickets, three each) and none of them is an infrastructure failure.
// Otherwise the check is SKIPPED, with what is missing. A real key found in a
// record is the one thing that fails whatever the state of the set.

import path from "node:path";
import type { RunRecord } from "../runner/schemas.ts";
import type { RealSet, SheetSearch } from "./real-sets.ts";
import { fail, pass, skip, type Check } from "./report.ts";

export const REAL_NEEDS =
  "`pnpm runs --real --host-run`, which needs OSTRA_DEV_MODEL_BASE_URL, OSTRA_DEV_MODEL_API_KEY and OSTRA_DEV_MODEL_ID (from the environment or ~/.config/ostra-dev/model.env), spends tokens, and lets the model's shell run as your account, so this command never starts it";

export type RealScan = { readonly rel: string; readonly files: number; readonly hits: readonly string[] };

const RUNS_NAME = "three runs per ticket on the model in model.env";
const RATING_NAME = 'rated blind, at least half are "merge as it is" or "merge with small edits"';
const RECORDING_NAME = "the same five measures on the real runs";

const countOf = (n: number, total: number): string => `${String(n)} of ${String(total)} runs recorded`;

const tooFew = (set: RealSet): string =>
  `${countOf(set.recorded, set.expected)} (the bar: every one of the 10 tickets, three times each; this set holds ${String(set.runs.length)} in all, from \`${String(set.manifest.tickets.length)} tickets x ${String(set.manifest.runsPerTicket)} runs\`)`;

const retryHint = (set: RealSet): string =>
  `${String(set.needRetry.length)} recorded runs ended in an error or a crash, or hit model errors (a rate limit, a server error, a bad key), and would count as unmergeable: \`pnpm runs --real --host-run --retry-failed\` redoes them (${set.needRetry.join(", ")})`;

export const realRunChecks = (sets: readonly RealSet[]): Check[] => {
  if (sets.length === 0) return [skip(RUNS_NAME, `no real set in .runs/real-* yet: ${REAL_NEEDS}`)];
  return sets.map((set) => {
    const name = `${RUNS_NAME} (set ${set.manifest.label})`;
    if (!set.complete) return skip(name, `${tooFew(set)}: run \`pnpm runs --real --host-run\` again, and the runs already recorded are kept`);
    if (set.needRetry.length > 0) return skip(name, retryHint(set));
    const completed = set.runs.filter((run) => run.record.outcome === "completed").length;
    const retried = set.manifest.retriedRuns ?? 0;
    return pass(
      name,
      `${countOf(set.recorded, set.expected)} on ${set.manifest.model.id} (${set.manifest.model.format}); ${String(completed)} completed, the rest ended as their record says (a timeout or a cap is a result, an error is not)${retried > 0 ? `; ${String(retried)} redone with --retry-failed` : ""}`,
    );
  });
};

export const realRatingChecks = (sets: readonly RealSet[], search: SheetSearch): Check[] => {
  if (sets.length === 0) return [skip(RATING_NAME, `needs the real runs first: ${REAL_NEEDS}; then \`pnpm sheet --sets=.runs/real-<label>\` and a reviewer`)];
  const incomplete = sets.filter((set) => !set.complete);
  if (incomplete.length > 0) return incomplete.map((set) => skip(`${RATING_NAME} (set ${set.manifest.label})`, `${tooFew(set)}: the rating is of all ${String(set.expected)}, so the runs come first`));
  const failing = sets.filter((set) => set.needRetry.length > 0);
  if (failing.length > 0) return failing.map((set) => skip(`${RATING_NAME} (set ${set.manifest.label})`, retryHint(set)));
  const { sheet } = search;
  if (sheet === undefined) {
    const stale = search.stale > 0 ? ` (${String(search.stale)} older sheets of these sets are not scored: made while the set held fewer runs, or before a run was redone)` : "";
    return [skip(RATING_NAME, `no rating sheet that shows exactly the ${String(sets.reduce((n, set) => n + set.expected, 0))} runs recorded now${stale}: \`pnpm sheet --sets=${sets.map((set) => set.rel).join(",")}\`, then a reviewer rates it (a person, not this harness)`)];
  }
  return sheet.verdicts.map((v) => ({ name: `${RATING_NAME} (${v.setDir})`, status: v.verdict.status, note: `${v.verdict.note}; sheet ${path.basename(sheet.dir)}` }));
};

const hasEveryMeasure = (r: RunRecord): boolean => r.spend.totalTokens > 0 && r.time.wallMs > 0 && r.turns.modelCalls > 0 && r.events.total > 0 && r.spend.callsWithoutUsage === 0;

/** The proxy's count over the calls that offered tools, against what OpenCode reported for the turn. */
const within2Percent = (r: RunRecord): boolean => {
  const reported = r.spend.agentReportedTokens;
  return reported !== null && reported > 0 && Math.abs(r.spend.turnTokens - reported) / reported <= 0.02;
};

export const realRecordingChecks = (sets: readonly RealSet[], scans: readonly RealScan[] | undefined): Check[] => {
  if (sets.length === 0) return [skip(RECORDING_NAME, `the real runs: ${REAL_NEEDS}`)];
  return sets.map((set) => {
    const name = `${RECORDING_NAME} (set ${set.manifest.label})`;
    const leaked = scans?.find((scan) => scan.rel === set.rel)?.hits ?? [];
    if (leaked.length > 0) return fail(name, `a real key was found in ${leaked.slice(0, 5).join(", ")}`);
    if (!set.complete) return skip(name, `${tooFew(set)}: the same five measures are asked of every run`);
    if (set.needRetry.length > 0) return skip(name, retryHint(set));
    const real = set.runs.map((run) => run.record);
    const missing = real.filter((r) => !hasEveryMeasure(r));
    // Only a run that finished its turn has OpenCode's own usage to compare with.
    const comparable = real.filter((r) => r.outcome === "completed");
    const off = comparable.filter((r) => !within2Percent(r));
    if (missing.length > 0 || off.length > 0) {
      return fail(name, `${String(missing.length)} runs with a missing measure (${missing.map((r) => r.runId).join(", ")}); the proxy's count is not within 2% of OpenCode's turn usage in ${String(off.length)} of ${String(comparable.length)} completed runs (${off.map((r) => r.runId).join(", ")})`);
    }
    const unpriced = real.filter((r) => r.spend.usd === null).length;
    if (unpriced > 0) {
      return skip(name, `set OSTRA_SPIKE_PRICE_INPUT and _OUTPUT in model.env: ${String(unpriced)} of ${String(real.length)} runs have tokens from the proxy but no dollars, and the bar asks for spend`);
    }
    const approvals = real.reduce((n, r) => n + r.approvals.requested, 0);
    const scanNote = scans === undefined ? "key scan not run (no model key present to look for)" : `no real key in the records (${String(scans.find((scan) => scan.rel === set.rel)?.files ?? 0)} files scanned)`;
    return pass(
      name,
      `${String(real.length)} real runs recorded, each with tokens counted by the proxy and priced from the configured prices, time, model calls and events and no call missing its usage; the proxy's count is within 2% of OpenCode's own turn usage in all ${String(comparable.length)} completed runs; ${String(approvals)} approvals in all (the policy asks only for package installs and runners, so this is the number of times a member would have been asked about a new dependency or a downloaded tool); ${scanNote}`,
    );
  });
};
