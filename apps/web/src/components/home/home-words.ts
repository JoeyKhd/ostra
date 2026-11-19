import { plural, t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// Home's rows in the panel's words (home.md): the reason a task waits and its one action, and each
// recent event. Each line is a list of parts so that commands, names and keys can be set in mono.

type Overview = RouterOutputs["home"]["overview"];
export type NeedsYouRow = Overview["needsYou"]["rows"][number];
export type NeedsYouDetail = NeedsYouRow["detail"];
export type NeedsYouReason = NeedsYouDetail["reason"];
export type ActivityRow = Overview["activity"][number];
export type ActivityEvent = ActivityRow["event"];

/** A run of text; `code` sets it in Plex Mono `--text` (commands, branches, names, keys). */
export type Part = { readonly text: string; readonly code?: boolean };

const plain = (text: string): Part => ({ text });
const code = (text: string): Part => ({ text, code: true });

/** The reason line of a Needs you row (home.md, the table of reasons). */
export const reasonParts = (detail: NeedsYouDetail): readonly Part[] => {
  switch (detail.reason) {
    case "approval":
      return detail.command === null ? [plain(t("home.reason.approvalNoCommand"))] : [plain(t("home.reason.approval")), code(detail.command)];
    case "plan":
      return [plain(t("home.reason.plan"))];
    case "draft_ready":
      return [plain(detail.prNumber === null ? t("home.reason.draftReadyNoNumber") : t("home.reason.draftReady", { n: detail.prNumber }))];
    case "question":
      return [plain(detail.question === null || detail.question === "" ? t("home.reason.questionNoText") : t("home.reason.question", { question: detail.question }))];
    case "no_changes":
      return [plain(t("home.reason.noChanges"))];
    case "stalled":
      return [plain(t("home.reason.stalled", { n: detail.minutes }))];
    case "spend_cap":
      return [plain(t("home.reason.spendCap"))];
    case "crashed":
      return [plain(t("home.reason.crashed"))];
    case "setup_failed":
      return [plain(detail.exitCode === null ? t("home.reason.setupFailedNoCode") : t("home.reason.setupFailed", { code: detail.exitCode }))];
    case "ticket_closed":
      return [plain(t("home.reason.ticketClosed"))];
    case "round_cap":
      return [plain(t("home.reason.roundCap"))];
    case "waiting_for_reviewer":
      return [plain(t("home.reason.waitingForReviewer"))];
    case "environment_proposal":
      return [plain(t("home.reason.environmentProposal"))];
    case "restore_conflict":
      return [plain(t("home.reason.restoreConflict"))];
    case "unstorable_event":
      return [plain(t("home.reason.unstorableEvent"))];
    case "files_outside_repos":
      return [plain(t("home.reason.filesOutsideRepos"))];
    case "no_provider_for_model":
      return [plain(t("home.reason.noProviderForModel"))];
    case "runner_awaiting_approval":
      return [plain(t("home.reason.runnerAwaitingApproval"))];
    default:
      return detail satisfies never;
  }
};

/** The one action of a Needs you row: what answering it means, on the task's page. */
export const actionKey = (reason: NeedsYouReason): MessageKey => {
  switch (reason) {
    case "approval":
      return "home.action.approve";
    case "plan":
      return "home.action.reviewPlan";
    case "draft_ready":
      return "home.action.reviewPr";
    case "question":
      return "home.action.answer";
    case "no_changes":
    case "stalled":
    case "spend_cap":
    case "crashed":
    case "setup_failed":
    case "ticket_closed":
    case "round_cap":
    case "waiting_for_reviewer":
    case "environment_proposal":
    case "restore_conflict":
    case "unstorable_event":
    case "files_outside_repos":
    case "no_provider_for_model":
    case "runner_awaiting_approval":
      return "home.action.openTask";
    default:
      return reason satisfies never;
  }
};

/**
 * Amber once (home.md): only the approval that has waited longest gets the filled amber button.
 * `null` when no row is an approval: then no button is amber.
 */
export const amberRow = (rows: readonly NeedsYouRow[]): NeedsYouRow["taskId"] | null => {
  const approvals = rows.filter((row) => row.detail.reason === "approval");
  if (approvals.length === 0) return null;
  return approvals.reduce((oldest, row) => (row.since < oldest.since ? row : oldest)).taskId;
};

export type ActivityIcon = "pr" | "stopped" | "runner" | "project" | "provider" | "github" | "approval" | "plan" | "driver" | "comment";

/** The icon of an event; colour only where the words carry it too (stopped). */
export const activityIcon = (event: ActivityEvent): ActivityIcon => {
  switch (event.kind) {
    case "pr.opened":
      return "pr";
    case "task.stopped":
      return "stopped";
    case "runner.registered":
      return "runner";
    case "project.created":
      return "project";
    case "provider.added":
      return "provider";
    case "github.connected":
      return "github";
    case "approval.answered":
      return "approval";
    case "plan.answered":
      return "plan";
    case "task.driver-changed":
      return "driver";
    case "pr.comment-accepted":
      return "comment";
    default:
      return event satisfies never;
  }
};

const stopReasons = ["requested", "rejected", "prs_closed", "runner_lost", "spend_cap", "runaway"] as const;
type StopReason = (typeof stopReasons)[number];
const isStopReason = (reason: string | null): reason is StopReason => stopReasons.some((known) => known === reason);

/** Splits a message around one `{name}` placeholder, so the value can be its own part. */
const around = (key: MessageKey, name: string, value: Part, params: Readonly<Record<string, string | number>> = {}): readonly Part[] => {
  const marker = "\u0000";
  const [before = "", after = ""] = t(key, { ...params, [name]: marker }).split(marker);
  return [plain(before), value, plain(after)].filter((part) => part.text !== "");
};

/** An event of the recent activity, in words, with its names in mono. */
export const activityParts = (event: ActivityEvent): readonly Part[] => {
  switch (event.kind) {
    case "pr.opened":
      return [plain(t("home.activity.prOpened", { n: event.prNumber, title: event.title }))];
    case "task.stopped":
      return around(isStopReason(event.reason) ? `home.activity.stoppedReason.${event.reason}` : "home.activity.taskStopped", "key", code(event.key));
    case "runner.registered": {
      if (event.pool === null) return around("home.activity.runnerJoinedPersonal", "runner", code(event.runner));
      const [before = "", after = ""] = t("home.activity.runnerJoined", { runner: "\u0000", pool: "\u0001" }).split("\u0000");
      const [middle = "", end = ""] = after.split("\u0001");
      return [plain(before), code(event.runner), plain(middle), code(event.pool), plain(end)].filter((part) => part.text !== "");
    }
    case "project.created":
      return [plain(t("home.activity.projectCreated", { project: event.project }))];
    case "provider.added":
      return [plain(t("home.activity.providerAdded", { provider: event.provider }))];
    case "github.connected":
      return [plain(t("home.activity.githubConnected"))];
    // Milestone 3 (ticket 36): what members did to a running task.
    case "approval.answered":
      return around(`home.activity.approvalAnswered.${event.decision ?? "unknown"}`, "key", code(event.key));
    case "plan.answered":
      return around("home.activity.planAnswered", "key", code(event.key));
    case "task.driver-changed":
      return around("home.activity.driverChanged", "key", code(event.key));
    case "pr.comment-accepted":
      return around("home.activity.commentAccepted", "key", code(event.key));
    default:
      return event satisfies never;
  }
};

/** The heading's live sentence of counts (home.md, `home.summary`). */
export const summaryText = (summary: Overview["summary"]): string =>
  t("home.summary", {
    running: plural(summary.running, "home.summaryRunning.one", "home.summaryRunning.other"),
    projects: plural(summary.projects, "home.summaryProjects.one", "home.summaryProjects.other"),
    queued: summary.queued,
    prs: plural(summary.prsToday, "home.summaryPrs.one", "home.summaryPrs.other"),
  });

/** US dollars, whole ("$1,104"), with cents under $10 ("$4.50"). */
export const formatSpend = (dollars: number | null): string => {
  if (dollars === null) return "–";
  const digits = dollars < 10 ? 2 : 0;
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(dollars)}`;
};

/** The month's name for the spend labels: "Nov". */
export const monthShort = (now: Date): string => new Intl.DateTimeFormat("en-GB", { month: "short" }).format(now);
export const monthLong = (now: Date): string => new Intl.DateTimeFormat("en-GB", { month: "long" }).format(now);
