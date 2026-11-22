import type { TicketAttachmentView, TicketFailure, TicketRoundView } from "@ostra/api";
import type { MessageFileId } from "@ostra/protocol";
import type { MessageFileView } from "@ostra/task-view";

import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";

// "What the agent got" (ticket-context.md; F-149, ticket 16): a ticket task's first message, from
// the first round of `tasks.ticketContext` (`TicketRoundView`, the API's). Its words are here, pure,
// for the message, the Ticket group's `Context` row and their tests.

/**
 * A round's files as the thread shows them: a failed one a Retry fetched since is given, with the
 * file it fetched (found by `fileOf`, the task's files); the rest as the round has them.
 */
export const shownAttachments = (round: Pick<TicketRoundView, "attachments">, fileOf: (fileId: MessageFileId) => MessageFileView | undefined): readonly TicketAttachmentView[] =>
  round.attachments.map((one): TicketAttachmentView => {
    if (one.state !== "failed" || one.retry?.state !== "ready") return one;
    const file = fileOf(one.retry.fileId);
    return file === undefined ? one : { state: "ready", file, from: one.from };
  });

/** The ticket's counts: what the agent got (files and links), all there were, and those that failed. */
export const ticketCounts = (round: { readonly attachments: readonly TicketAttachmentView[] } & Pick<TicketRoundView, "links" | "comments">) => {
  const given = round.attachments.filter((one) => one.state === "ready").length + round.links.length;
  const failed = round.attachments.filter((one) => one.state === "failed").length;
  const leftOut = round.attachments.filter((one) => one.state === "left-out").length;
  return { given, total: round.attachments.length + round.links.length, failed, leftOut, comments: round.comments.length };
};

/** The Attachments label's count: `7`, or `20 of 23` when some were left out or failed. */
export const attachmentsCountText = (counts: ReturnType<typeof ticketCounts>): string =>
  counts.given === counts.total ? String(counts.total) : t("task.ticketContext.countOf", { n: counts.given, of: counts.total });

/** The header's facts: `14:02 · CALC-170 from Linear`. */
export const contextMetaText = (input: { readonly at: number | null; readonly ticketKey: string; readonly tracker: string }): string =>
  input.at === null ? t("task.ticketContext.metaKey", { key: input.ticketKey, tracker: input.tracker }) : t("task.ticketContext.meta", { time: formatClock(input.at), key: input.ticketKey, tracker: input.tracker });

/** `once`, `twice`, `three times`, `{n} times`. */
const timesText = (n: number): string => {
  switch (n) {
    case 1:
      return t("task.ticketContext.once");
    case 2:
      return t("task.ticketContext.twice");
    case 3:
      return t("task.ticketContext.thrice");
    default:
      return t("task.ticketContext.times", { n });
  }
};

/** What follows each of a list's names in a sentence: `, ` between, ` and ` before the last, nothing after it. */
export const nameJoiners = (count: number): readonly string[] =>
  Array.from({ length: count }, (_, index) => (index === count - 1 ? "" : index === count - 2 ? t("task.ticketContext.and") : ", "));

/**
 * Why they didn't load, as far as ostra knows: how often it tried and when last (`Linear didn't give
 * them: ostra tried three times, the last at 14:02.`). The tracker's own answer isn't recorded.
 */
export const failureText = (failure: TicketFailure | null, tracker: string): string => {
  if (failure === null) return t("task.ticketContext.failedUnknown", { tracker });
  return t("task.ticketContext.failedTried", { tracker, times: timesText(failure.tries), time: formatClock(failure.lastAt) });
};

/** The Ticket group's `Context` row: `7 attachments · 3 comments`, `20 of 23 attachments`, or the failure in red. */
export const contextRowText = (counts: ReturnType<typeof ticketCounts>): { readonly text: string; readonly failed: boolean } => {
  if (counts.failed > 0) return { text: plural(counts.failed, "task.ticketContext.rowFailedOne", "task.ticketContext.rowFailed"), failed: true };
  if (counts.given !== counts.total) return { text: t("task.ticketContext.rowSome", { n: counts.given, of: counts.total }), failed: false };
  const parts = [counts.total === 0 ? null : plural(counts.total, "task.ticketContext.attachmentsOne", "task.ticketContext.attachments"), counts.comments === 0 ? null : plural(counts.comments, "task.ticketContext.commentsOne", "task.ticketContext.comments")];
  const text = parts.filter((part) => part !== null).join(" · ");
  return { text: text === "" ? t("task.ticketContext.rowNothing") : text, failed: false };
};

/** The comments shown before `Show {n} more`: the newest two, in the ticket's order. */
export const COMMENTS_SHOWN = 2;

export const shownComments = <T>(comments: readonly T[], all: boolean): { readonly shown: readonly T[]; readonly hidden: number } =>
  all || comments.length <= COMMENTS_SHOWN ? { shown: comments, hidden: 0 } : { shown: comments.slice(-COMMENTS_SHOWN), hidden: comments.length - COMMENTS_SHOWN };

/**
 * "Send ticket updates"' answer: the round after the press (`afterRound` + 1). Nothing new says so;
 * any change went to the agent as a `ticket-update` message.
 */
export type UpdatesAnswer = { readonly kind: "reading" } | { readonly kind: "nothing-new" } | { readonly kind: "sent" } | { readonly kind: "unreadable" };

export const updatesAnswerOf = (rounds: readonly Pick<TicketRoundView, "round" | "nothingNew" | "unreadable">[], afterRound: number): UpdatesAnswer => {
  const answer = rounds.find((round) => round.round > afterRound);
  if (answer === undefined) return { kind: "reading" };
  if (answer.unreadable) return { kind: "unreadable" };
  return answer.nothingNew ? { kind: "nothing-new" } : { kind: "sent" };
};

export const updatesAnswerText = (answer: UpdatesAnswer, agent: string, tracker: string): string => {
  switch (answer.kind) {
    case "reading":
      return t("task.ticketContext.updatesReading", { tracker });
    case "nothing-new":
      return t("task.ticketContext.updatesNothingNew");
    case "sent":
      return t("task.ticketContext.updatesSent", { agent });
    case "unreadable":
      return t("task.ticketContext.updatesUnreadable", { tracker });
    default:
      return answer satisfies never;
  }
};
