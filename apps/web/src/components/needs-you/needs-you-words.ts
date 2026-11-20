import { t } from "@/lib/messages";

import type { NeedsYouDetail } from "@/components/home/home-words";

// The Needs you page's pure parts (needs-you.md; F-036, F-062): the notification rows as the page
// draws them, their order and grouping, which row opens by itself, the Done tab's outcomes and the
// panel's "where these reach you". `NeedsYouView` wires them to ticket 36's `notifications.*`.

/** What an approval's inline answer needs (ticket 36: "what's needed to answer inline"). */
export type ApprovalAsk = {
  readonly kind: "approval";
  readonly approvalId: string;
  readonly agent: string;
  /** `add a dependency`: what the agent wants, in words. */
  readonly summary: string;
  /** The preset rule's name, or `null` for a custom rule. */
  readonly rule: string | null;
  /** The command, path or URL, shown in a code chip. */
  readonly subject: string;
  /** What "Approve for this task" adds to the task's rules (`pnpm add`), or `null` when it can't. */
  readonly pattern: string | null;
};

export type PlanEntryView = { readonly status: "pending" | "in_progress" | "completed" | "cancelled"; readonly text: string };

export type PlanAsk = {
  readonly kind: "plan";
  readonly planId: string;
  readonly entries: readonly PlanEntryView[];
  /** `null` when the viewer drives; the driver's name when someone else does. */
  readonly driver: string | null;
};

export type QuestionAsk = {
  readonly kind: "question";
  readonly questionId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly driver: string | null;
};

export type InlineAsk = ApprovalAsk | PlanAsk | QuestionAsk;

/** Who answered: the viewer, another member, or nobody (a rule, an expiry). */
export type AnsweredBy = { readonly kind: "you" } | { readonly kind: "member"; readonly name: string };

export type Outcome =
  | { readonly kind: "approved-once"; readonly by: AnsweredBy }
  | { readonly kind: "approved-task"; readonly by: AnsweredBy }
  | { readonly kind: "denied"; readonly by: AnsweredBy }
  | { readonly kind: "by-rule" }
  | { readonly kind: "plan-approved"; readonly by: AnsweredBy }
  | { readonly kind: "answered"; readonly by: AnsweredBy }
  | { readonly kind: "expired" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "closed" };

export type NotificationView = {
  /** The row's key: its item, or its task for one from before items. */
  readonly id: string;
  /** The member's notification of it, to mark read; `null` when none reached them (it shows read). */
  readonly notificationId: string | null;
  readonly taskId: string;
  /** The ticket key, or the task's short ID. */
  readonly key: string;
  readonly title: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly at: number;
  readonly read: boolean;
  /** Home's reason (`home-words.ts`); a `pr_ready` notification arrives as `draft_ready`. */
  readonly detail: NeedsYouDetail;
  /** What answers it in place, or `null` when its action opens the task. */
  readonly ask: InlineAsk | null;
  /** Set once answered or closed: the Done tab's column, and a live answer on the Open tab. */
  readonly outcome: Outcome | null;
  /** This member's own failed delivery of it (needs-you.md, States). */
  readonly deliveryFailed: { readonly channel: "email" | "ticket"; readonly error: string } | null;
};

export type ProjectGroup = { readonly project: NotificationView["project"]; readonly rows: readonly NotificationView[] };

const newest = (rows: readonly NotificationView[], pick: (row: NotificationView) => boolean): number =>
  rows.reduce((top, row) => (pick(row) && row.at > top ? row.at : top), Number.NEGATIVE_INFINITY);

/**
 * The Open tab's groups: by project, groups by their newest unread notification, then their newest
 * one; inside a group, unread first, then newest first.
 */
export const groupByProject = (rows: readonly NotificationView[]): readonly ProjectGroup[] => {
  const groups = new Map<string, NotificationView[]>();
  for (const row of rows) {
    const list = groups.get(row.project.id);
    if (list === undefined) groups.set(row.project.id, [row]);
    else list.push(row);
  }
  return [...groups.values()]
    .map((list) => ({
      project: list[0]?.project ?? { id: "", name: "" },
      rows: [...list].sort((a, b) => (a.read === b.read ? b.at - a.at : a.read ? 1 : -1)),
    }))
    .sort((a, b) => {
      const unread = newest(b.rows, (row) => !row.read) - newest(a.rows, (row) => !row.read);
      if (unread !== 0 && Number.isFinite(unread)) return unread;
      const aUnread = Number.isFinite(newest(a.rows, (row) => !row.read));
      const bUnread = Number.isFinite(newest(b.rows, (row) => !row.read));
      if (aUnread !== bUnread) return aUnread ? -1 : 1;
      return newest(b.rows, () => true) - newest(a.rows, () => true);
    });
};

/** The row that opens by itself on load: the first unread one that answers inline, in page order. */
export const autoOpen = (groups: readonly ProjectGroup[]): string | null => {
  for (const group of groups) for (const row of group.rows) if (!row.read && row.ask !== null && row.outcome === null) return row.id;
  return null;
};

/** Every row in page order, for the keyboard's up and down. */
export const pageOrder = (groups: readonly ProjectGroup[]): readonly string[] => groups.flatMap((group) => group.rows.map((row) => row.id));

const by = (who: AnsweredBy): string => (who.kind === "you" ? t("needsYouPage.you") : who.name);

/** The Done tab's outcome, and the line an answered row shows on the Open tab. */
export const outcomeWords = (outcome: Outcome): string => {
  switch (outcome.kind) {
    case "approved-once":
      return t("needsYouPage.outcome.approvedOnce", { who: by(outcome.by) });
    case "approved-task":
      return t("needsYouPage.outcome.approvedTask", { who: by(outcome.by) });
    case "denied":
      return t("needsYouPage.outcome.denied", { who: by(outcome.by) });
    case "by-rule":
      return t("needsYouPage.outcome.byRule");
    case "plan-approved":
      return t("needsYouPage.outcome.planApproved", { who: by(outcome.by) });
    case "answered":
      return t("needsYouPage.outcome.answered", { who: by(outcome.by) });
    case "expired":
      return t("needsYouPage.outcome.expired");
    case "cancelled":
      return t("needsYouPage.outcome.cancelled");
    case "closed":
      return t("needsYouPage.outcome.closed");
    default:
      return outcome satisfies never;
  }
};

/** `What waits on you across your projects. 6 unread.` */
export const ledeWords = (unread: number): string => (unread === 0 ? t("needsYouPage.ledeNone") : t("needsYouPage.lede", { n: unread }));

/** The inline block's title. */
export const askTitle = (ask: InlineAsk): string => {
  switch (ask.kind) {
    case "approval":
      return t("needsYouPage.title.approval");
    case "plan":
      return t("needsYouPage.title.plan");
    case "question":
      return t("needsYouPage.title.question");
    default:
      return ask satisfies never;
  }
};

/** The plan's entries shown in place before `{n} more on the task`. */
export const PLAN_SHOWN = 8;

/** How long the Open tab must be visible before its rows are marked read (needs-you.md, Reading). */
export const READ_AFTER_MS = 2000;

/** The notifications to mark read: those of the unread rows rendered on the Open tab. */
export const toMarkRead = (rows: readonly NotificationView[]): readonly string[] =>
  rows.flatMap((row) => (row.read || row.notificationId === null ? [] : [row.notificationId]));

/** The member's choices for the panel (ticket 37): where these notifications reach them. */
export type ReachView = {
  readonly tracker: string | null;
  /** The member turned every moment off for the ticket. */
  readonly ticketOff: boolean;
  readonly email: { readonly kind: "on"; readonly address: string; readonly delayMinutes: number } | { readonly kind: "off" } | { readonly kind: "install-off" };
};

/** A failed delivery's line. */
export const deliveryWords = (failed: NonNullable<NotificationView["deliveryFailed"]>): string =>
  failed.channel === "email" ? t("needsYouPage.deliveryFailedMail", { error: failed.error }) : t("needsYouPage.deliveryFailedTicket", { error: failed.error });
