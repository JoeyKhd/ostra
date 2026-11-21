import type { FileLeftOutReason, TicketContextComment, TicketContextLink } from "@ostra/protocol";

import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";

import type { ThreadFile } from "./file-words";

// "What the agent got" (ticket-context.md; F-149, ticket 16): a ticket task's first message, from
// the first round of `tasks.ticketContext`. Its words are here, pure, for the message, the Ticket
// group's `Context` row and their tests.

/**
 * One of the ticket's files as the agent got it (ticket-context.md, "Components"): given (its stored
 * file), left out by the ticket's limits with why, or failed to load. Kept in the ticket's order, so
 * a failed one keeps its place.
 */
export type TicketAttachment =
  | { readonly state: "ready"; readonly file: ThreadFile }
  | { readonly state: "left-out"; readonly name: string; readonly size: number | null; readonly reason: Extract<FileLeftOutReason, "too-big" | "too-many" | "total-too-big"> }
  | { readonly state: "failed"; readonly name: string };

/** Why the failed ones didn't load: what the tracker answered, how often, and when last; `null` fields when unknown. */
export type TicketFailure = { readonly status: number | null; readonly tries: number; readonly lastAt: number | null };

/** What the first message shows, from the first `ticket.context_read` and the task. */
export type TicketContextView = {
  /** When ostra put the context together. */
  readonly at: number;
  readonly ticketKey: string;
  /** The tracker's name, as the key line has it: `Linear`. */
  readonly tracker: string;
  /** `fetching` while the task starts; `read` once the fetch is done or gave up. */
  readonly state: "fetching" | "read";
  readonly description: string | null;
  readonly attachments: readonly TicketAttachment[];
  readonly links: readonly TicketContextLink[];
  readonly comments: readonly TicketContextComment[];
  readonly failure: TicketFailure | null;
  /** The tracker declared `ticketFiles: none`: its files weren't fetched. */
  readonly filesNotOffered: boolean;
  /** The rendered first prompt, for `Show the prompt`; text, never HTML. */
  readonly prompt: string | null;
  /** The model that can't see images, when the ticket's images went as files. */
  readonly imagesAsFilesFor: string | null;
};

/** The ticket's counts: what the agent got (files and links), all there were, and those that failed. */
export const ticketCounts = (view: Pick<TicketContextView, "attachments" | "links" | "comments">) => {
  const given = view.attachments.filter((one) => one.state === "ready").length + view.links.length;
  const failed = view.attachments.filter((one) => one.state === "failed").length;
  const leftOut = view.attachments.filter((one) => one.state === "left-out").length;
  return { given, total: view.attachments.length + view.links.length, failed, leftOut, comments: view.comments.length };
};

/** The Attachments label's count: `7`, or `20 of 23` when some were left out or failed. */
export const attachmentsCountText = (counts: ReturnType<typeof ticketCounts>): string =>
  counts.given === counts.total ? String(counts.total) : t("task.ticketContext.countOf", { n: counts.given, of: counts.total });

/** The header's facts: `14:02 · CALC-170 from Linear`. */
export const contextMetaText = (view: Pick<TicketContextView, "at" | "ticketKey" | "tracker">): string =>
  t("task.ticketContext.meta", { time: formatClock(view.at), key: view.ticketKey, tracker: view.tracker });

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

/** Why they didn't load: `Linear answered 503 three times, the last at 14:02.` */
export const failureText = (failure: TicketFailure | null, tracker: string): string => {
  if (failure === null) return t("task.ticketContext.failedUnknown", { tracker });
  const last = failure.lastAt === null ? "" : t("task.ticketContext.lastAt", { time: formatClock(failure.lastAt) });
  return failure.status === null
    ? t("task.ticketContext.failedNoAnswer", { tracker, times: timesText(failure.tries), last })
    : t("task.ticketContext.failedAnswered", { tracker, status: failure.status, times: timesText(failure.tries), last });
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
