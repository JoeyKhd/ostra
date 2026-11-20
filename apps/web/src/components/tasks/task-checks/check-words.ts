import type { CheckStatus } from "@ostra/protocol";

import { plural, t } from "@/lib/messages";

// The Checks tab's pure parts (task-checks.md, F-054, ADR 0052): a check's status and duration in
// words, a turn's summary, the output's tail as plain text, the PR's draft line and the fix hint.

/** A check as the tab shows it: not started yet, running, or finished with ADR 0052's result. */
export type CheckState = "waiting" | "running" | CheckStatus;

/** One check of one turn (ticket 39's `tasks.checks`). */
export type CheckRunView = {
  readonly checkId: string;
  readonly name: string;
  readonly command: string;
  /** The repo it ran in, or `null` for the workspace root (Q188). */
  readonly repo: string | null;
  readonly status: CheckState;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** The check's limit, for `timed out after …`. */
  readonly timeoutMs: number;
  readonly startedAt: number | null;
  /** The output's end (at most 16 KiB), as the runner sent it. Plain text, never interpreted. */
  readonly outputTail: string;
  /** Where the full output downloads from, or `null` when it wasn't saved. */
  readonly downloadUrl: string | null;
};

/** One turn's checks: the real turn number, which may skip (ticket 47's decision). */
export type TurnChecksView = {
  readonly turn: number;
  readonly at: number;
  /** The commit the checks ran on: the first repo's, which a task with one repo shows in the turn's header. */
  readonly sha: string | null;
  /** Milestone 4 (F-098): the commit the checks ran on in each repo, from the push after the turn. */
  readonly heads: readonly { readonly repo: string; readonly sha: string }[];
  readonly checks: readonly CheckRunView[];
};

/** One repo's section of a turn (F-098): its checks and the commit they ran on there. `repo` `null`: the workspace root's. */
export type RepoChecksSection = { readonly repo: string | null; readonly sha: string | null; readonly checks: readonly CheckRunView[] };

/**
 * A turn's checks per repo, for a task with several (the m4 spec grows `task-checks.md` with a
 * section per repo): one section for each repo a check ran in, in the project's order (a repo the
 * project has dropped since comes after), then the checks that ran at the workspace root. `null`
 * for a task with one repo, whose turn stays one list.
 */
export const repoSectionsOf = (turn: TurnChecksView, repos: readonly string[]): readonly RepoChecksSection[] | null => {
  if (repos.length < 2) return null;
  const order = [...new Set([...repos, ...turn.checks.flatMap((check) => (check.repo === null ? [] : [check.repo]))])];
  const sections = order.flatMap((repo): RepoChecksSection[] => {
    const checks = turn.checks.filter((check) => check.repo === repo);
    return checks.length === 0 ? [] : [{ repo, sha: turn.heads.find((head) => head.repo === repo)?.sha ?? null, checks }];
  });
  const root = turn.checks.filter((check) => check.repo === null);
  return root.length === 0 ? sections : [...sections, { repo: null, sha: null, checks: root }];
};

/** A failed, timed-out or unrunnable check: what "Ask the agent to fix" sends. */
export const isFailing = (status: CheckState): boolean => status === "failed" || status === "timed-out" || status === "error";

/** `0.4 s`, `38.5 s`, `1 min 12 s`, `10 min`. */
export const formatCheckDuration = (ms: number): string => {
  if (ms < 60_000) return t("checks.seconds", { n: (Math.round(ms / 100) / 10).toFixed(1) });
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? t("checks.minutes", { n: minutes }) : t("checks.minutesSeconds", { m: minutes, s: seconds });
};

/** A running check's live time: whole seconds, `12 s`. */
export const formatLive = (startedAt: number, now: number): string => t("checks.live", { n: Math.max(0, Math.floor((now - startedAt) / 1000)) });

/** The status word of a row (`passed`, `failed · exit 1`, `timed out after 5 min`, …). */
export const statusWord = (check: CheckRunView): string => {
  switch (check.status) {
    case "waiting":
      return t("checks.status.waiting");
    case "running":
      return t("checks.status.running");
    case "passed":
      return t("checks.status.passed");
    case "failed":
      return check.exitCode === null ? t("checks.status.failedNoCode") : t("checks.status.failed", { code: check.exitCode });
    case "timed-out":
      return t("checks.status.timedOut", { limit: formatCheckDuration(check.timeoutMs) });
    case "error":
      return t("checks.status.error");
    default:
      return check.status satisfies never;
  }
};

/** Whether a row shows its duration: a timed-out check's limit says it, an unrunnable one has none. */
export const durationOf = (check: CheckRunView, now: number): string | null => {
  switch (check.status) {
    case "running":
      return check.startedAt === null ? null : formatLive(check.startedAt, now);
    case "passed":
    case "failed":
      return check.durationMs === null ? null : formatCheckDuration(check.durationMs);
    case "waiting":
    case "timed-out":
    case "error":
      return null;
    default:
      return check.status satisfies never;
  }
};

export type SummaryPart = { readonly text: string; readonly tone: "red" | "green" };

/** A turn's summary: `1 failed · 2 passed`, failures first, in red; passes in green. */
export const summaryOf = (checks: readonly CheckRunView[]): readonly SummaryPart[] => {
  const count = (status: CheckState) => checks.filter((check) => check.status === status).length;
  const parts: SummaryPart[] = [];
  const failed = count("failed");
  const timedOut = count("timed-out");
  const error = count("error");
  const passed = count("passed");
  if (failed > 0) parts.push({ text: t("checks.summary.failed", { n: failed }), tone: "red" });
  if (timedOut > 0) parts.push({ text: t("checks.summary.timedOut", { n: timedOut }), tone: "red" });
  if (error > 0) parts.push({ text: t("checks.summary.error", { n: error }), tone: "red" });
  if (passed > 0) parts.push({ text: t("checks.summary.passed", { n: passed }), tone: "green" });
  return parts;
};

/** Whether a turn's checks are still running (or waiting to). */
export const turnRunning = (turn: TurnChecksView): boolean => turn.checks.some((check) => check.status === "running" || check.status === "waiting");

/** A turn's total time: its checks' durations, a timed-out check counting its limit. */
export const turnTotalMs = (turn: TurnChecksView): number =>
  turn.checks.reduce((sum, check) => sum + (check.status === "timed-out" ? check.timeoutMs : (check.durationMs ?? 0)), 0);

/** The tab's marker after `Checks`, from the newest turn. */
export type ChecksMarker = { readonly kind: "none" } | { readonly kind: "running" } | { readonly kind: "passed" } | { readonly kind: "failing"; readonly count: number };

export const markerOf = (turns: readonly TurnChecksView[]): ChecksMarker => {
  const newest = turns[0];
  if (newest === undefined || newest.checks.length === 0) return { kind: "none" };
  if (turnRunning(newest)) return { kind: "running" };
  const failing = newest.checks.filter((check) => isFailing(check.status)).length;
  return failing > 0 ? { kind: "failing", count: failing } : { kind: "passed" };
};

/** The properties panel's `Checks` row, from the newest turn, or `null` when none ran. */
export const propertyOf = (turns: readonly TurnChecksView[]): { readonly failing: number; readonly passed: number; readonly running: boolean } | null => {
  const newest = turns[0];
  if (newest === undefined || newest.checks.length === 0) return null;
  return {
    failing: newest.checks.filter((check) => isFailing(check.status)).length,
    passed: newest.checks.filter((check) => check.status === "passed").length,
    running: turnRunning(newest),
  };
};

// ---------- the output ----------

/** The most lines an output block shows before `Show all {n} lines`. */
export const TAIL_LINES = 40;

// ESC [ … final byte (CSI), ESC ] … BEL or ESC \ (OSC), and lone two-byte escapes.
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

/** The output as plain text: ANSI escapes stripped, `\r\n` as `\n`, no trailing blank line. Nothing is interpreted. */
export const plainOutput = (tail: string): readonly string[] => {
  const text = tail.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  return text === "" ? [] : text.split("\n");
};

/** The lines shown: all of them, or the last 40 until `Show all`. */
export const shownLines = (lines: readonly string[], all: boolean): readonly string[] => (all || lines.length <= TAIL_LINES ? lines : lines.slice(-TAIL_LINES));

export const outputLabel = (lines: number): string => (lines >= TAIL_LINES ? t("checks.outputLast") : plural(lines, "checks.outputLines.one", "checks.outputLines.other"));

// ---------- the PR's draft line ----------

/** What the checks did to one repo's PR (ticket 23): ostra's draft, ostra's ready, or a person's draft. */
export type PrDraftLine = {
  readonly number: number;
  /** The repo's name when the task has several, for `PR #483 in calculator-web`. */
  readonly repo: string | null;
  readonly url: string;
  readonly state: "draft-by-ostra" | "ready-by-ostra" | "draft-by-person";
  readonly turn: number;
};

export const prName = (line: PrDraftLine): string => (line.repo === null ? t("checks.pr.name", { n: line.number }) : t("checks.pr.nameIn", { n: line.number, repo: line.repo }));

export const prLineWords = (line: PrDraftLine): { readonly bold: string; readonly rest: string } => {
  const pr = prName(line);
  switch (line.state) {
    case "draft-by-ostra":
      return { bold: t("checks.pr.isDraft", { pr }), rest: t("checks.pr.draftByOstra", { n: line.turn }) };
    case "ready-by-ostra":
      return { bold: t("checks.pr.isReady", { pr }), rest: t("checks.pr.readyByOstra", { n: line.turn }) };
    case "draft-by-person":
      return { bold: t("checks.pr.isDraft", { pr }), rest: t("checks.pr.draftByPerson") };
    default:
      return line.state satisfies never;
  }
};

// ---------- Ask the agent to fix ----------

/** Who may send, and how it goes (the composer's rule, ticket 23). */
export type FixDelivery =
  | { readonly kind: "next-turn" }
  | { readonly kind: "after-turn" }
  | { readonly kind: "reopen" }
  | { readonly kind: "not-driver"; readonly driver: string };

export const fixHint = (delivery: FixDelivery, failing: number, agent: string): string => {
  switch (delivery.kind) {
    case "next-turn":
      return failing === 1 ? t("checks.fix.one", { agent }) : t("checks.fix.several", { n: failing, agent });
    case "after-turn":
      return t("checks.fix.afterTurn", { agent });
    case "reopen":
      return t("checks.fix.reopen");
    case "not-driver":
      return t("checks.fix.driving", { name: delivery.driver });
    default:
      return delivery satisfies never;
  }
};
