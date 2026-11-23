"use client";

import { AwaitingApprovalBanner } from "@/components/approvals/approval-block";
import type { WaitingTask } from "@/components/approvals/approval-block";
import { NeedsYou } from "@/components/ui/needs-you";
import { t } from "@/lib/messages";

import { inPlace, needAnnouncement, noticeLine, replyLine } from "./needs-you-card-words";
import type { Need, ReplyHow } from "./needs-you-card-words";
import { TicketClosedBlock } from "./task-answers";
import type { CardAction } from "./task-answers";
import { LimitBlock, RestoreConflict } from "./task-ticket";
import type { LimitState } from "./task-ticket";

// The needs-you cards at the end of the thread, just above the composer (the maintainer,
// 2026-11-21: needs you is part of the chat, not a block above the tabs). Each is the shared
// amber-ruled block (app-design.md, rule 3). Approvals and questions stay where the agent asked
// them; the plan and the review loop's round limit keep their own cards here.
//
// Milestone 10 (F-151, ticket 13, parts.md part 11): flush with the prose, at that part's sizes
// (the thread's `NeedsYouInThread`); no indent, since the compact thread has no avatar column.

export type NeedsYouCardsProps = {
  readonly needs: readonly Need[];
  /** The agent's name, as its messages' headers show it. */
  readonly agent: string;
  /** How a reply is given here: the composer sends, reopens, or the viewer takes over first. */
  readonly how: ReplyHow;
  readonly limit: { readonly task: LimitState; readonly reopen: CardAction };
  readonly ticketClosed: { readonly stop: CardAction; readonly keep: CardAction };
  readonly conflict: { readonly canAnswer: boolean; readonly dismiss: { readonly run: () => void; readonly pending: boolean } };
  /** F-040: the outside task's approval, from the project's Needs approval; `undefined` until it loads. */
  readonly awaiting: WaitingTask | undefined;
};

/** The agent ended its turn and waits: its message is just above, so the card points up at it and never repeats it (`states-asks.md` cell 5). */
const ReplyCard = ({ asked, agent, how }: { readonly asked: boolean; readonly agent: string; readonly how: ReplyHow }) => (
  <NeedsYou title={t("taskPage.needsYou")} need="reply">
    <p>{replyLine(asked, agent, how)}</p>
  </NeedsYou>
);

const card = (need: Need, props: NeedsYouCardsProps) => {
  switch (need.kind) {
    case "reply":
      return <ReplyCard key="reply" asked={need.asked} agent={props.agent} how={props.how} />;
    case "notice":
      return (
        <NeedsYou key="notice" title={t("taskPage.needsYou")} need="notice">
          <p className="whitespace-pre-wrap">{noticeLine(need.reason, need.summary)}</p>
        </NeedsYou>
      );
    case "limit":
      return <LimitBlock key="limit" task={props.limit.task} reopen={props.limit.reopen} />;
    case "ticket-closed":
      return <TicketClosedBlock key="ticket-closed" summary={need.summary} stop={props.ticketClosed.stop} keep={props.ticketClosed.keep} />;
    case "restore-conflict":
      return <RestoreConflict key="restore-conflict" savedWorkUrl={null} canAnswer={props.conflict.canAnswer} dismiss={props.conflict.dismiss} />;
    case "awaiting-approval":
      return props.awaiting === undefined ? null : (
        <div key="awaiting-approval" data-waits="other">
          <AwaitingApprovalBanner task={props.awaiting} />
        </div>
      );
    // Drawn where the agent asked (approvals, questions), or by their own card at the end (the plan,
    // the review loop's limit): nothing more here.
    case "approval":
    case "question":
    case "plan":
    case "round-cap":
      return null;
    default:
      return need satisfies never;
  }
};

/** The kinds this list draws itself; the rest have their own place in the thread. */
export const drawnHere = (need: Need): boolean => !inPlace(need) && need.kind !== "plan" && need.kind !== "round-cap";

export const NeedsYouCards = (props: NeedsYouCardsProps) => {
  const here = props.needs.filter(drawnHere);
  return here.length === 0 ? null : <div data-part="needs-you-cards">{here.map((need) => card(need, props))}</div>;
};

/**
 * The live region for the thread (F-081/c2): polite, always mounted, so a need that appears is read
 * out once, by its mark and its line. The cards themselves stay keyboard reachable in reading order.
 */
export const NeedsYouLive = ({ needs, agent, how }: { readonly needs: readonly Need[]; readonly agent: string; readonly how: ReplyHow }) => {
  const first = needs[0];
  return (
    <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="needs-you-live">
      {first === undefined ? "" : needAnnouncement(first, agent, how)}
    </p>
  );
};
