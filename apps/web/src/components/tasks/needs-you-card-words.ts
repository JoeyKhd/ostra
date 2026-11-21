import type { StoredEvent } from "@ostra/protocol";

import { needsYouReasonText } from "@/components/projects/task-row-words";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// What waits on a person on the task page, as cards in the chat (the maintainer, 2026-11-21:
// "needs you ... is part of the chat window, not a component up top"; app-design.md, rule 3).
// Approvals and questions sit where the agent asked them, under their tool row or in its message;
// everything else is a card at the end of the thread, just above the composer. Nothing here is
// drawn above the tabs, and the agent's own message is never shown twice.

type Task = RouterOutputs["tasks"]["get"];
type Item = Task["needsYou"][number];
type NeedsYouReason = Item["reason"];

/** One thing that waits on a person, in the order the thread shows them. */
export type Need =
  /** Open approvals: each card sits under the tool row that asked. */
  | { readonly kind: "approval"; readonly count: number }
  /** The agent's question with its form, in the message that asked it. */
  | { readonly kind: "question" }
  /** The plan to approve or change, at the end of the thread. */
  | { readonly kind: "plan" }
  /** The review loop stopped at its round limit (the rounds' own card). */
  | { readonly kind: "round-cap" }
  /** A task from outside waits for a member's approval to start (F-040). */
  | { readonly kind: "awaiting-approval" }
  /** A runaway limit or a crash stopped the session (task-limits.md). */
  | { readonly kind: "limit"; readonly what: NonNullable<Task["limit"]> | "crashed" }
  /** Its ticket was closed while it ran (F-066). */
  | { readonly kind: "ticket-closed"; readonly summary: string | null }
  /** The saved work conflicts with the branch (task-reopen.md). */
  | { readonly kind: "restore-conflict"; readonly itemId: Item["id"] }
  /** The agent ended its turn and waits for a reply; its last message is the thread's last. */
  | { readonly kind: "reply"; readonly asked: boolean }
  /** Any other reason, in one line: core's own sentence, or the reason's words. */
  | { readonly kind: "notice"; readonly reason: NeedsYouReason | null; readonly summary: string | null };

export type NeedKind = Need["kind"];

/** The kinds drawn where the agent asked, inside its message; the rest are at the thread's end. */
export const inPlace = (need: Need): boolean => need.kind === "approval" || need.kind === "question";

/** What `needsOf` reads: `tasks.get`'s fields, nothing the page works out by itself. */
export type NeedsInput = Pick<Task, "state" | "group" | "reason" | "kind" | "limit" | "needsYou"> & {
  readonly openApprovals: number;
  readonly openQuestions: number;
  /** A proposed plan waits for the driver (`plan.itemId` set, not approved). */
  readonly planWaiting: boolean;
};

/**
 * Whether the agent's message asks something: it ends on a question mark, past any closing
 * Markdown, quote or bracket. Only the card's words depend on it, never what the page allows.
 */
export const asksSomething = (text: string | null): boolean => {
  if (text === null) return false;
  const end = text.trimEnd().replace(/[\s*_`'"’”)\]]+$/u, "");
  return end.endsWith("?") || end.endsWith("？");
};

/** Every need of the task now, in the thread's order: in place first, then the end's cards. */
export const needsOf = (task: NeedsInput): readonly Need[] => {
  const needs: Need[] = [];
  const itemOf = (reason: NeedsYouReason): Item | undefined => task.needsYou.find((item) => item.reason === reason);
  if (task.openApprovals > 0) needs.push({ kind: "approval", count: task.openApprovals });
  if (task.openQuestions > 0) needs.push({ kind: "question" });
  if (task.planWaiting) needs.push({ kind: "plan" });
  const needsYou = task.state === "needs_you";
  if (needsYou && task.reason === "round_cap") needs.push({ kind: "round-cap" });
  if (task.state === "awaiting_approval") needs.push({ kind: "awaiting-approval" });
  // A crash wins over a limit, as the limit card reads them (task-limits.md).
  const what = task.reason === "crashed" ? "crashed" : task.limit;
  const limited = needsYou && what !== null;
  if (needsYou && what !== null) needs.push({ kind: "limit", what });
  const ticketClosed = itemOf("ticket_closed");
  if (ticketClosed !== undefined) needs.push({ kind: "ticket-closed", summary: ticketClosed.summary });
  const conflict = itemOf("restore_conflict");
  if (conflict !== undefined) needs.push({ kind: "restore-conflict", itemId: conflict.id });
  // Any other reason the task needs you for: a reply when the agent ended its turn, else one line.
  const worded =
    task.reason === "approval" ||
    task.reason === "question" ||
    task.reason === "plan" ||
    task.reason === "round_cap" ||
    (task.kind === "refine" && task.reason === "draft_ready");
  if (task.group === "needs-you" && task.state !== "awaiting_approval" && !limited && !worded && ticketClosed === undefined && conflict === undefined) {
    const noChanges = itemOf("no_changes");
    if (task.reason === "no_changes" || noChanges !== undefined) {
      // The item's summary is the agent's last message (F-065): the card points at it, never repeats it.
      needs.push({ kind: "reply", asked: asksSomething(noChanges?.summary ?? null) });
    } else {
      const item = task.needsYou.find((one) => one.reason === task.reason) ?? task.needsYou.find((one) => one.summary !== null);
      needs.push({ kind: "notice", reason: item?.reason ?? null, summary: item?.summary ?? null });
    }
  }
  return needs;
};

/** How the member answers a reply: the composer sends, reopens, they take over first, or nothing can now. */
export type ReplyHow = "send" | "reopen" | "watch" | "none";

/** The reply card's line: what the agent did, pointing at its message above, and how to answer. */
export const replyLine = (asked: boolean, agent: string, how: ReplyHow): string => {
  const what = asked ? t("taskPage.needsYouCard.asked", { agent }) : t("taskPage.needsYouCard.finished", { agent });
  const then = howWords(how);
  return then === "" ? what : `${what} ${then}`;
};

const howWords = (how: ReplyHow): string => {
  switch (how) {
    case "send":
      return t("taskPage.needsYouCard.replyBelow");
    case "reopen":
      return t("taskPage.needsYouCard.reopenBelow");
    case "watch":
      return t("taskPage.needsYouCard.takeOver");
    case "none":
      return "";
    default:
      return how satisfies never;
  }
};

/** A notice's line: core's own sentence when it wrote one, else the reason in words. */
export const noticeLine = (reason: NeedsYouReason | null, summary: string | null): string =>
  summary ?? (reason === null ? t("taskPage.needsYouDefault") : t("taskPage.needsYouCard.reason", { reason: needsYouReasonText(reason) }));

/**
 * What the live region says when a need appears (F-081): the mark and its one line, so a member on
 * a screen reader hears what waits without finding the card first.
 */
export const needAnnouncement = (need: Need, agent: string, how: ReplyHow): string => {
  const line = needLine(need, agent, how);
  // A card whose title already says it (`Needs you · spend cap reached`) is read as it is.
  return line.startsWith(t("taskPage.needsYou")) ? line : `${t("taskPage.needsYou")}: ${line}`;
};

export const needLine = (need: Need, agent: string, how: ReplyHow): string => {
  switch (need.kind) {
    case "approval":
      return need.count === 1 ? t("taskPage.needsYouCard.approval", { agent }) : t("taskPage.needsYouCard.approvals", { agent, n: need.count });
    case "question":
      return t("taskPage.needsYouCard.question", { agent });
    case "plan":
      return t("taskPage.needsYouCard.plan", { agent });
    case "round-cap":
      return t("taskPage.needsYouCard.roundCap");
    case "awaiting-approval":
      return t("taskPage.needsYouCard.awaitingApproval");
    case "limit":
      return t("taskPage.limit.title", { what: t(`taskPage.limit.${need.what}`) });
    case "ticket-closed":
      return t("taskAnswers.ticketClosed.title");
    case "restore-conflict":
      return t("taskPage.restoreConflict.title");
    case "reply":
      return replyLine(need.asked, agent, how);
    case "notice":
      return noticeLine(need.reason, need.summary);
    default:
      return need satisfies never;
  }
};

/** The composer's hint while the agent waits for a reply (`null`: the composer's own). */
export const replyHint = (needs: readonly Need[], agent: string): string | null =>
  needs.some((need) => need.kind === "reply") ? t("taskPage.needsYouCard.hint", { agent }) : null;

/**
 * Whether an open question only repeats the agent's message that asked it (same turn, same words):
 * then the card points at that message instead of showing the text twice.
 */
export const questionRepeatsMessage = (events: readonly StoredEvent[], questionId: string, message: string): boolean => {
  const at = events.findIndex(({ event }) => event.kind === "question.asked" && event.questionId === questionId);
  const asked = events[at]?.event;
  if (asked?.kind !== "question.asked") return false;
  for (let i = at - 1; i >= 0; i -= 1) {
    const event = events[i]?.event;
    if (event === undefined) continue;
    if (event.kind === "turn.started") return false;
    if (event.kind === "agent.message" && event.turnId === asked.turnId && event.subagentId === undefined) return event.text.trim() === message.trim();
  }
  return false;
};
