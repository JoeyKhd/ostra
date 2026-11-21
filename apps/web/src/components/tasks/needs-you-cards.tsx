"use client";

import { CornerLeftUpIcon } from "lucide-react";

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
// amber-ruled block (app-design.md, rule 3), indented to the messages' text like an approval under
// its tool row. Approvals and questions stay where the agent asked them; the plan and the review
// loop's round limit keep their own cards here.

/** The cards' place in the chat: the messages' text column (the 28px avatar and its 12px gap). */
const CARD = "my-2.5 ml-10";

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

/** The agent ended its turn and waits: its message is just above, so the card says so and stops there. */
const ReplyCard = ({ asked, agent, how }: { readonly asked: boolean; readonly agent: string; readonly how: ReplyHow }) => (
  <NeedsYou title={t("taskPage.needsYou")} need="reply" className={CARD}>
    <p className="flex items-start gap-1.5">
      <CornerLeftUpIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75] text-faint" />
      <span>{replyLine(asked, agent, how)}</span>
    </p>
  </NeedsYou>
);

const card = (need: Need, props: NeedsYouCardsProps) => {
  switch (need.kind) {
    case "reply":
      return <ReplyCard key="reply" asked={need.asked} agent={props.agent} how={props.how} />;
    case "notice":
      return (
        <NeedsYou key="notice" title={t("taskPage.needsYou")} need="notice" className={CARD}>
          <p className="whitespace-pre-wrap">{noticeLine(need.reason, need.summary)}</p>
        </NeedsYou>
      );
    case "limit":
      return <LimitBlock key="limit" task={props.limit.task} reopen={props.limit.reopen} className={CARD} />;
    case "ticket-closed":
      return <TicketClosedBlock key="ticket-closed" summary={need.summary} stop={props.ticketClosed.stop} keep={props.ticketClosed.keep} className={CARD} />;
    case "restore-conflict":
      return <RestoreConflict key="restore-conflict" savedWorkUrl={null} canAnswer={props.conflict.canAnswer} dismiss={props.conflict.dismiss} className={CARD} />;
    case "awaiting-approval":
      return props.awaiting === undefined ? null : (
        <div key="awaiting-approval" className="ml-10">
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
