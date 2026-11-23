import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

import { reasonParts } from "./home-words";
import type { NeedsYouDetail, Part } from "./home-words";

// Home's board view in the panel's words (home-board.md, F-062): the five columns over the task's
// lifecycle states, and each card's status line. `HomeBoard` wires these to ticket 36's `home.board`.

/** The board's columns, in `domain-model.md`'s order. `Finished` folds merged, done and stopped. */
export const boardColumns = ["needs-you", "queued", "running", "in-review", "finished"] as const;
export type BoardColumnId = (typeof boardColumns)[number];

/** The in-review sub-state in words (`PR #481 · CI running`). */
export type ReviewStep = "ci-running" | "fixing-ci" | "ai-review" | "fixing-findings" | "waiting-for-reviewer";

/** Milestone 10 (F-151/c6): the code host's CI on the task's PRs, counted in jobs, while it runs. */
export type CiJobs = { readonly done: number; readonly total: number };

/** What a preparing box is doing. */
export type PrepareStep = "restoring-snapshot" | "starting-services" | "checking-out";

/** What a running agent is doing now, from the task's latest event. */
export type RunningActivity = { readonly verb: "running" | "editing" | "reading"; readonly subject: string };

/** The source of a card's status line (ticket 36's decision: nothing is dropped from the card). */
export type CardStatus =
  | { readonly kind: "needs-you"; readonly detail: NeedsYouDetail }
  | { readonly kind: "queued"; readonly on: { readonly kind: "pool"; readonly name: string } | { readonly kind: "personal" } }
  | { readonly kind: "preparing"; readonly step: PrepareStep | null }
  | { readonly kind: "running"; readonly activity: RunningActivity | null }
  | { readonly kind: "in-review"; readonly prs: readonly number[]; readonly step: ReviewStep | null; readonly ciJobs?: CiJobs | null }
  | { readonly kind: "merged"; readonly prs: readonly number[] }
  | { readonly kind: "done" }
  | { readonly kind: "stopped"; readonly reason: { readonly kind: "spend-cap" } | { readonly kind: "ticket-closed" } | { readonly kind: "by"; readonly name: string } | null };

export type BoardCard = {
  readonly taskId: string;
  readonly project: { readonly id: string; readonly name: string };
  /** The ticket key, or `null` for a prompt task (the card shows `Prompt`). */
  readonly key: string | null;
  readonly title: string;
  readonly driver: string | null;
  /** When the task entered its state: the card's age. */
  readonly since: number;
  readonly status: CardStatus;
};

export type BoardColumnData = {
  /** The column's full total, apart from the page of cards. */
  readonly total: number;
  readonly cards: readonly BoardCard[];
  /** The next page's cursor, or `null` when every card is shown. */
  readonly next: string | null;
};

export type BoardData = Readonly<Record<BoardColumnId, BoardColumnData>>;

/** How many cards a column shows before `N more` (home-board.md). */
export const BOARD_PAGE = 20;

const plain = (text: string): Part => ({ text });
const code = (text: string): Part => ({ text, code: true });

const columnTitleKey: Readonly<Record<BoardColumnId, MessageKey>> = {
  "needs-you": "home.board.column.needsYou",
  queued: "home.board.column.queued",
  running: "home.board.column.running",
  "in-review": "home.board.column.inReview",
  finished: "home.board.column.finished",
};

const columnEmptyKey: Readonly<Record<BoardColumnId, MessageKey>> = {
  "needs-you": "home.board.empty.needsYou",
  queued: "home.board.empty.queued",
  running: "home.board.empty.running",
  "in-review": "home.board.empty.inReview",
  finished: "home.board.empty.finished",
};

export const columnTitle = (column: BoardColumnId): string => t(columnTitleKey[column]);
export const columnEmpty = (column: BoardColumnId): string => t(columnEmptyKey[column]);

const reviewWords = (step: ReviewStep, ciJobs: CiJobs | null): string => {
  switch (step) {
    case "ci-running":
      // CI is counted in jobs (`CI running · 2 of 4 jobs`); checks are only ostra's, in the box.
      return ciJobs === null || ciJobs.total === 0
        ? t("home.board.review.ciRunning")
        : t("home.board.review.ciRunningJobs", { jobs: plural(ciJobs.total, "task.ci.jobsOf.one", "task.ci.jobsOf.other", { done: ciJobs.done, total: ciJobs.total }) });
    case "fixing-ci":
      return t("home.board.review.fixingCi");
    case "ai-review":
      return t("home.board.review.aiReview");
    case "fixing-findings":
      return t("home.board.review.fixingFindings");
    case "waiting-for-reviewer":
      return t("home.board.review.waitingForReviewer");
    default:
      return step satisfies never;
  }
};

const prepareWords = (step: PrepareStep): string => {
  switch (step) {
    case "restoring-snapshot":
      return t("home.board.prepare.restoringSnapshot");
    case "starting-services":
      return t("home.board.prepare.startingServices");
    case "checking-out":
      return t("home.board.prepare.checkingOut");
    default:
      return step satisfies never;
  }
};

/** `PR #481`, or `3 PRs` for several. */
const prsWords = (prs: readonly number[]): string => {
  const [first] = prs;
  if (prs.length === 1 && first !== undefined) return t("home.board.pr", { n: first });
  return plural(prs.length, "home.board.prs.one", "home.board.prs.other");
};

/** The card's status line (home-board.md, the table of columns), as parts so commands go in mono. */
export const cardStatusParts = (status: CardStatus): readonly Part[] => {
  switch (status.kind) {
    case "needs-you":
      return reasonParts(status.detail);
    case "queued":
      return status.on.kind === "pool" ? [plain(t("home.board.waitingFor")), code(status.on.name)] : [plain(t("home.board.waitingForRunner"))];
    case "preparing":
      return [plain(status.step === null ? t("home.board.preparing") : t("home.board.preparingStep", { step: prepareWords(status.step) }))];
    case "running":
      if (status.activity === null) return [plain(t("home.board.working"))];
      return [plain(t(`home.board.activity.${status.activity.verb}`)), code(status.activity.subject)];
    case "in-review": {
      const prs = status.prs.length === 0 ? t("home.board.inReview") : prsWords(status.prs);
      return [plain(status.step === null ? prs : `${prs} · ${reviewWords(status.step, status.ciJobs ?? null)}`)];
    }
    case "merged":
      return [plain(status.prs.length === 0 ? t("home.board.merged") : `${t("home.board.merged")} · ${prsWords(status.prs)}`)];
    case "done":
      return [plain(t("home.board.done"))];
    case "stopped": {
      const reason = status.reason;
      if (reason === null) return [plain(t("home.board.stopped"))];
      switch (reason.kind) {
        case "spend-cap":
          return [plain(t("home.board.stoppedWhy", { why: t("home.board.stopReason.spendCap") }))];
        case "ticket-closed":
          return [plain(t("home.board.stoppedWhy", { why: t("home.board.stopReason.ticketClosed") }))];
        case "by":
          return [plain(t("home.board.stoppedWhy", { why: t("home.board.stopReason.by", { name: reason.name }) }))];
        default:
          return reason satisfies never;
      }
    }
    default:
      return status satisfies never;
  }
};

/** `38 more`: what a column holds past its shown cards. */
export const moreWords = (column: BoardColumnData): string | null => {
  const rest = column.total - column.cards.length;
  return rest > 0 && column.next !== null ? t("home.board.more", { n: rest }) : null;
};

/** No card in any column: the board says so once, under the headers. */
export const boardEmpty = (board: BoardData): boolean => boardColumns.every((column) => board[column].total === 0);

/** The board's two query parameters: `?view=board` and `&project=<id>`; the overview has none. */
export type HomeView = "overview" | "board";

export const viewOf = (params: { readonly get: (name: string) => string | null }): HomeView => (params.get("view") === "board" ? "board" : "overview");

/** The URL for a view and a project, keeping the path's other parameters out. */
export const homeHref = (view: HomeView, project: string | null): string => {
  if (view === "overview") return "/";
  return project === null ? "/?view=board" : `/?view=board&project=${encodeURIComponent(project)}`;
};

/** The phone's one column at a time (F-075): `Needs you 5`. */
export const columnChip = (column: BoardColumnId, board: BoardData | null): string =>
  board === null ? columnTitle(column) : `${columnTitle(column)} ${String(board[column].total)}`;

/** The member's last view, kept in this browser as a convenience; any storage failure reads as none. */
export const VIEW_STORAGE_KEY = "ostra.home.view";
export const readStoredView = (): HomeView | null => {
  try {
    const value = globalThis.localStorage.getItem(VIEW_STORAGE_KEY);
    return value === "board" || value === "overview" ? value : null;
  } catch {
    return null;
  }
};
export const storeView = (view: HomeView): void => {
  try {
    globalThis.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Private windows and blocked storage: the URL still holds the view.
  }
};
