// The checks behind the criteria, as plain functions over what the stages
// produced: the oracle's outcomes, the dry-run's records, the sheet. Nothing
// here runs a process, so each can be tested on its own.

import { csvLine } from "../rating/csv.ts";
import type { SheetResult } from "../rating/make-sheet.ts";
import { RATINGS_HEADER, type KeyFile } from "../rating/schemas.ts";
import { parseRatings, verdictOf, verdictsBySet, scoreRater } from "../rating/score.ts";
import { STUB_PRICING, usdOf } from "../runner/pricing.ts";
import type { RunRecord } from "../runner/schemas.ts";
import { EXPECTATIONS } from "../tickets/solutions.ts";
import { REQUIRED_MIX, TICKETS } from "../tickets/tickets.ts";
import { TicketKindSchema, type TicketKind } from "../tickets/schema.ts";
import { check, type Check } from "./report.ts";
import type { ToolCallResult } from "./tool-calls.ts";
import { expectedAcceptance, expectedCi, type OracleOutcome } from "./oracle.ts";

export const ticketMixCheck = (): Check => {
  const counts: Record<TicketKind, number> = { bug: 0, feature: 0, refactor: 0, tests: 0 };
  for (const ticket of TICKETS) counts[ticket.kind] += 1;
  const ok = TICKETS.length === 10 && TicketKindSchema.options.every((kind) => counts[kind] === REQUIRED_MIX[kind]);
  return check(
    "10 tickets: 3 bug fixes, 3 small features, 2 refactors, 2 that add tests",
    ok,
    `${String(counts.bug)} bug fixes, ${String(counts.feature)} features, ${String(counts.refactor)} refactors and ${String(counts.tests)} that add tests, filed against a sample repo, a small TypeScript calculator with a test suite (sample-repo/)`,
  );
};

const ids = (outcomes: readonly OracleOutcome[]): string => outcomes.map((o) => o.ticket.id).join(", ");

export type OracleChecks = { readonly baseFails: Check; readonly referencePasses: Check; readonly variants: Check };

export const oracleChecks = (outcomes: readonly OracleOutcome[]): OracleChecks => {
  const base = outcomes.filter((o) => o.variant === "base");
  const good = outcomes.filter((o) => o.variant === "good");
  const others = outcomes.filter((o) => o.variant !== "base" && o.variant !== "good");
  const baseBad = base.filter((o) => o.acceptance.passed || !o.ci.green);
  const goodBad = good.filter((o) => !o.acceptance.passed || !o.ci.green);
  const otherBad = others.filter((o) => (o.acceptance.passed ? "pass" : "fail") !== expectedAcceptance(o.variant) || (o.ci.green ? "green" : "red") !== expectedCi(o.variant));
  return {
    baseFails: check(
      "on the unmodified sample, every ticket's acceptance check fails and the sample's own CI is green",
      base.length > 0 && baseBad.length === 0,
      `${String(base.length - baseBad.length)} of ${String(base.length)} tickets${baseBad.length > 0 ? `; not as expected: ${ids(baseBad)}` : ""}`,
    ),
    referencePasses: check(
      "with its reference solution applied, every ticket's acceptance check passes and CI is green",
      good.length > 0 && goodBad.length === 0,
      `${String(good.length - goodBad.length)} of ${String(good.length)} tickets${goodBad.length > 0 ? `; not as expected: ${ids(goodBad)}` : ""}`,
    ),
    variants: check(
      "the checkers catch what goes wrong: nothing done, half done, something broken, a thin test suite",
      others.length > 0 && otherBad.length === 0,
      `${String(others.length - otherBad.length)} of ${String(others.length)} failure variants judged as scripted (${others.map((o) => `${o.ticket.id}/${o.variant}`).join(", ")})${otherBad.length > 0 ? `; not as expected: ${ids(otherBad)}` : ""}`,
    ),
  };
};

const within = (counted: number, reported: number): boolean => reported > 0 && Math.abs(counted - reported) / reported <= 0.02;

export type DryChecks = {
  readonly completed: Check;
  readonly formats: Check;
  readonly verdicts: Check;
  readonly meter: Check;
  readonly recording: Check;
  readonly paths: Check;
};

export const dryRunChecks = (records: readonly RunRecord[], expectedRuns: number, failed: readonly { runId: string; message: string }[]): DryChecks => {
  const notCompleted = records.filter((r) => r.outcome !== "completed" || r.stopReason !== "end_turn");
  const formats = new Set(records.map((r) => r.model.format));
  const wrongVerdict = records.filter((r) => {
    if (r.variant === undefined) return true;
    const want = EXPECTATIONS[r.variant];
    return (r.checks.acceptance.passed ? "pass" : "fail") !== want.acceptance || (r.checks.ci.green ? "green" : "red") !== want.ci;
  });
  const holes = records.filter((r) => r.spend.callsWithoutUsage > 0 || r.modelErrors.rateLimited + r.modelErrors.serverErrors + r.modelErrors.clientErrors > 0);
  const offCount = records.filter((r) => r.spend.agentReportedTokens === null || !within(r.spend.turnTokens, r.spend.agentReportedTokens));
  const incomplete = records.filter((r) => !(r.spend.totalTokens > 0 && r.time.wallMs > 0 && r.turns.modelCalls > 0 && r.events.total > 0));
  const badArithmetic = records.filter((r) => r.spend.usd === null || Math.abs(r.spend.usd - usdOf({ input: r.spend.inputTokens, output: r.spend.outputTokens, cacheRead: r.spend.cacheReadTokens, cacheWrite: r.spend.cacheWriteTokens, reasoning: 0 }, STUB_PRICING)) > 1e-9);
  const approvals = records.filter((r) => r.approvals.requested > 0);
  const questions = records.filter((r) => r.turns.questions > 0 && r.outcome === "completed");
  const approvalsOk = approvals.length > 0 && approvals.every((r) => r.approvals.allowed === r.approvals.requested);
  return {
    completed: check(
      `${String(expectedRuns)} runs went through OpenCode over ACP and the key proxy, and each turn ended end_turn`,
      failed.length === 0 && records.length === expectedRuns && notCompleted.length === 0,
      `${String(records.length)} of ${String(expectedRuns)} recorded, ${String(notCompleted.length)} not completed${notCompleted.length > 0 ? ` (${notCompleted.map((r) => `${r.runId}: ${r.outcome}/${r.stopReason ?? "-"}`).join(", ")})` : ""}, ${String(failed.length)} threw${failed.length > 0 ? ` (${failed.map((f) => f.runId).join(", ")})` : ""}`,
    ),
    formats: check("both API formats were driven through the proxy", formats.has("openai") && formats.has("anthropic"), `formats seen: ${[...formats].sort().join(", ")}`),
    verdicts: check(
      "the checkers' verdict on every run matches what its script was meant to do",
      records.length > 0 && wrongVerdict.length === 0,
      `${String(records.length - wrongVerdict.length)} of ${String(records.length)} runs; ${String(records.filter((r) => r.checks.acceptance.passed).length)} passed acceptance, ${String(records.filter((r) => !r.checks.ci.green).length)} had red CI${wrongVerdict.length > 0 ? `; not as expected: ${wrongVerdict.map((r) => r.runId).join(", ")}` : ""}`,
    ),
    meter: check(
      "the usage the stub reports reaches the record unchanged: the proxy's token count equals what OpenCode reports for the turn, and no call is missing its usage",
      records.length > 0 && offCount.length === 0 && holes.length === 0,
      `${String(records.length - offCount.length)} of ${String(records.length)} runs agree to within 2% (the proxy's count over the calls that offered tools against OpenCode's turn usage); ${String(holes.length)} runs with a call that reported no usage or an error. This is plumbing: both numbers come from the stub's own usage report, so it does not test the proxy's metering against a real endpoint, which only the real runs' within-2% check does`,
    ),
    recording: check(
      "every run recorded spend from the proxy, time, turns, approvals and events, and the dollars follow from the tokens",
      records.length > 0 && incomplete.length === 0 && badArithmetic.length === 0,
      `${String(records.length - incomplete.length)} of ${String(records.length)} runs with tokens, time, model calls and events all above zero; dollars equal tokens times the price in ${String(records.length - badArithmetic.length)} (the stub's made-up price list: the dry-run says nothing about real spend)`,
    ),
    paths: check(
      "an approval and a question were each recorded and answered without ending the run",
      approvalsOk && questions.length > 0,
      `${String(approvals.length)} runs asked for an approval (allowed once each: ${approvals.map((r) => `${r.runId} x${String(r.approvals.requested)}`).join(", ")}); ${String(questions.length)} runs asked a question and carried on (${questions.map((r) => r.runId).join(", ")})`,
    ),
  };
};

export type Guard = { readonly name: string; readonly record: RunRecord | undefined; readonly wanted: RunRecord["outcome"] };

export const guardCheck = (guards: readonly Guard[]): Check => {
  const bad = guards.filter((g) => g.record?.outcome !== g.wanted);
  return check(
    "a run past its token cap, its dollar cap or its time limit is cancelled, and recorded as such",
    guards.length > 0 && bad.length === 0,
    guards.map((g) => `${g.name}: ${g.record === undefined ? "no record" : `${g.record.outcome} after ${(g.record.time.wallMs / 1000).toFixed(1)} s, ${String(g.record.spend.totalTokens)} tokens`} (wanted ${g.wanted})`).join("; "),
  );
};

export type SheetChecks = { readonly blind: Check; readonly order: Check; readonly key: Check };

/** The blind sheet made from the dry-run: what it must hide, and that the key undoes it. */
export const sheetChecks = (sheet: SheetResult, again: SheetResult, other: SheetResult, records: readonly RunRecord[]): SheetChecks => {
  const text = sheet.text;
  const idsUnique = new Set(sheet.key.entries.map((e) => e.id)).size === sheet.key.entries.length;
  const leaks = [
    ...records.filter((r) => text.includes(r.runId)).map((r) => `run ID ${r.runId}`),
    ...(text.includes(records[0]?.model.id ?? "\u0000") ? ["model ID"] : []),
    ...(/-r\d\b/.test(text) ? ["a run suffix"] : []),
    ...(/\b(?:wallMs|totalTokens|turnTokens|perMinute|approvals)\b/.test(text) ? ["a recorded measure"] : []),
  ];
  const sortedRuns = [...sheet.key.entries].sort((a, b) => Number(a.ticketId.replace(/^\D+/, "")) - Number(b.ticketId.replace(/^\D+/, "")) || a.runId.localeCompare(b.runId));
  const sameOrderAsRuns = sortedRuns.every((entry, i) => entry.id === sheet.key.entries[i]?.id);
  const byId = new Map(sheet.key.entries.map((e) => [e.id, e.runId]));
  const keyCovers = records.every((r) => [...byId.values()].includes(r.runId)) && byId.size === records.length;
  const template = sheet.key.entries.length;
  return {
    blind: check(
      "the sheet shows each pull request under a random ID, and hides which run, which model, and how long, how much or how many turns",
      sheet.count === records.length && idsUnique && leaks.length === 0,
      `${String(sheet.count)} entries with unique IDs; ${leaks.length === 0 ? "no run ID, model ID, run suffix or recorded measure appears in it" : `LEAKS: ${leaks.join(", ")}`}; each entry carries the ticket, the CI result a reviewer would see, the agent's description and the diff`,
    ),
    order: check(
      "the order is shuffled, and a seed reproduces a sheet (and another seed another)",
      !sameOrderAsRuns && sheet.text === again.text && JSON.stringify(sheet.key.entries) === JSON.stringify(again.key.entries) && JSON.stringify(sheet.key.entries.map((e) => e.id)) !== JSON.stringify(other.key.entries.map((e) => e.id)),
      `seed ${String(sheet.seed)} twice gives the same ${String(sheet.count)} entries in the same order; seed ${String(other.seed)} gives a different order; neither is the order of the runs`,
    ),
    key: check(
      "the key (a separate file) maps every ID back to exactly one run, and the ratings template has a row for each ID",
      keyCovers && template === records.length,
      `${String(byId.size)} IDs map to ${String(records.length)} runs; the template has ${String(template)} rows`,
    ),
  };
};

const csvFor = (key: KeyFile, ratingFor: (index: number) => string, notes = ""): string => `${[csvLine(RATINGS_HEADER), ...key.entries.map((entry, i) => csvLine([entry.id, ratingFor(i), notes]))].join("\n")}\n`;

/**
 * The scorer on synthetic ratings. They prove the arithmetic and the edge
 * cases of the tool, nothing about any model: they are made here, by the
 * harness, from the dry-run's key.
 */
export const scorerCheck = (key: KeyFile): Check => {
  const n = key.entries.length;
  const half = Math.ceil(n / 2);
  const rated = (mergeable: number): ((index: number) => string) => (i) => (i < mergeable ? (i % 2 === 0 ? "merge-as-is" : "merge-with-small-edits") : "reject");
  const verdictFor = (...files: string[]): string => {
    const raters = files.map((csv, i) => ({ rater: `r${String(i + 1)}`, parsed: parseRatings(csv) }));
    return verdictsBySet(key, raters)
      .map((v) => v.verdict.status)
      .join("/");
  };
  const exactlyHalf = verdictFor(csvFor(key, rated(half)));
  const justUnder = verdictFor(csvFor(key, rated(half - 1)));
  const everything = verdictFor(csvFor(key, rated(n)));
  const incomplete = verdictFor(csvFor(key, (i) => (i === 0 ? "" : rated(n)(i))));
  const invalid = verdictFor(csvFor(key, (i) => (i === 0 ? "merge-it" : rated(n)(i))));
  const none = verdictOf([]).status;
  const strictest = verdictFor(csvFor(key, rated(n)), csvFor(key, rated(half - 1)));
  const quotedNotes = scoreRater(key, "q", parseRatings(csvFor(key, rated(half), 'looks fine, "mostly"\nsecond line'))).mergeable;
  const ok = n >= 4 && exactlyHalf === "PASS" && justUnder === "FAIL" && everything === "PASS" && incomplete === "SKIPPED" && invalid === "SKIPPED" && none === "SKIPPED" && strictest === "FAIL" && quotedNotes === half;
  return check(
    "the scorer counts merge-as-is and merge-with-small-edits against the bar, on synthetic ratings (a test of the tool, not a result)",
    ok,
    `${String(n)} runs: exactly half mergeable ${exactlyHalf}, one fewer ${justUnder}, all ${everything}; one unrated ${incomplete}; a word off the scale ${invalid}; no file ${none}; two raters, one strict ${strictest}; notes with commas, quotes and line breaks read back (${String(quotedNotes)} mergeable)`,
  );
};

/** One run of the `escape` script: whether its write landed outside the workspace, and what its first two tool calls (the write, then the read) came to. */
export type EscapeRun = { readonly record: RunRecord; readonly landed: boolean; readonly calls: readonly ToolCallResult[] };

const describeCalls = (run: EscapeRun): string => {
  const [write, read] = run.calls;
  return `the write ${run.landed ? "landed" : "did not land"} (its tool call ${write?.status ?? "never ran"}), the read of a file outside ${read?.status ?? "never ran"}`;
};

/**
 * The file tools' boundary, with a positive control. Under the policy's rules a
 * write and a read outside the workspace must both fail; under `allow *` alone,
 * the same script's write must land and its read must work. Without the control,
 * a call that failed for another reason (a path form, a tool error) would read as
 * the rule doing its job.
 */
export const escapeCheck = (control: EscapeRun, refused: EscapeRun): Check => {
  const kindsOk = (run: EscapeRun): boolean => run.calls[0]?.kind === "edit" && run.calls[1]?.kind === "read";
  const controlOk = control.landed && kindsOk(control) && control.calls[0]?.status === "completed" && control.calls[1]?.status === "completed";
  const refusedOk = !refused.landed && kindsOk(refused) && refused.calls[0]?.status === "failed" && refused.calls[1]?.status === "failed";
  const carriedOn = refused.record.outcome === "completed" && refused.record.checks.acceptance.passed;
  return check(
    "an agent's file tools cannot leave its workspace: under the policy's rules a write and a read outside it are refused and the run carries on; under allow-everything alone the same write lands and the same read works",
    controlOk && refusedOk && carriedOn,
    `under the rules: ${describeCalls(refused)}, the run ${refused.record.outcome} and its acceptance check ${refused.record.checks.acceptance.passed ? "passed" : "failed"}; control (allow-everything only): ${describeCalls(control)}. The rule is external_directory deny; the shell tool is not covered by it`,
  );
};
