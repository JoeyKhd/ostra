import { ChevronRightIcon, PauseCircleIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";

import { readAgentMessage } from "@ostra/domain/agent-message";
import type { AgentMessage } from "@ostra/domain/agent-message";
import { CI_FILES_DIR } from "@ostra/protocol";
import type { MessageIntent } from "@ostra/protocol";
import type { TaskUIMessage } from "@ostra/task-view";

import { releasedHoldText, roundName } from "@/components/tasks/review/review-words";
import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";

import { SentDiffCommentsList } from "./diff-comments-message";
import { AgentMarkdown, SafeLink } from "./renderers";
import type { RoundView } from "./thread/round-of";
import { Quoted } from "./thread/quoted";
import { Segments } from "./thread/segments";
import { aiReviewHeadWords, aiReviewReadsWords, automaticTurnWords, findingsSentSegments } from "./thread/words";

// The thread's member messages that ostra wrote for the agent (F-072's fix for diff comments, for
// every kind): their text is the agent's prompt, ostra's instructions around marked blocks, so the
// thread never draws it. `readAgentMessage` (`@ostra/domain/agent-message`) reads the blocks' data
// and the facts ostra's lines carry; the bubble draws them as its tag after the time and its body
// (milestone 10's parts.md part 2). Every piece of quoted text (a comment, a check's output, a
// finding) is a React text node, escaped, never HTML. A member's own words are Markdown, drawn as
// the agent's prose is: no raw HTML, safe links, no remote image.

/** The message ostra wrote for the agent, as `readAgentMessage` reads it; `null` for a member's own (an optimistic send is always theirs). */
export const agentMessageOf = (message: TaskUIMessage): AgentMessage | null => {
  if (message.role !== "user" || message.metadata?.optimistic === true) return null;
  const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return readAgentMessage({ text, intent: message.metadata?.author?.intent });
};

/**
 * ostra sent it by itself (a round, the closing turn, a review or refine task's first prompt): the
 * header names ostra, not the member it's written as.
 */
export const isAutomatic = (message: AgentMessage): boolean => {
  switch (message.kind) {
    case "fix-ci":
    case "fix-findings":
    case "closing-turn":
    case "ai-review":
    case "refine":
      return true;
    case "pr-comment":
    case "fix-checks":
    case "update-branch":
    case "keep-working":
    case "plan-revision":
    case "changes-requested":
    case "plan-approved":
    case "question-answer":
    case "approval-answer":
    case "quoted":
      return false;
    default:
      return message satisfies never;
  }
};

const CI_CONCLUSIONS = ["failure", "timed_out", "action_required", "startup_failure", "error"] as const;
type CiConclusion = (typeof CI_CONCLUSIONS)[number];
const isCiConclusion = (value: string): value is CiConclusion => CI_CONCLUSIONS.some((known) => known === value);

/** A CI check's conclusion in the panel's words; one the panel doesn't know, as the code host wrote it. */
const conclusionWords = (conclusion: string | null): string | null =>
  conclusion === null ? null : isCiConclusion(conclusion) ? t(`task.agentMessage.ciConclusion.${conclusion}`) : conclusion;

const blockingOf = (message: Extract<AgentMessage, { readonly kind: "fix-findings" }>) => message.findings.filter((finding) => finding.severity === "blocking");

type AiReview = Extract<AgentMessage, { readonly kind: "ai-review" }>;

/** The one PR an AI review reads, which its header names and links; `null` for several. */
const onlyPullRequest = (message: AiReview) => (message.pullRequests.length === 1 ? (message.pullRequests[0] ?? null) : null);

/** What the header names after "AI review of ": `PR #12`, or `2 PRs`. */
const reviewedWords = (message: AiReview): string => {
  const only = onlyPullRequest(message);
  return only === null ? plural(message.pullRequests.length, "task.agentMessage.aiReview.prs.one", "task.agentMessage.aiReview.prs.other") : t("task.agentMessage.aiReview.pr", { n: only.number });
};

/** What the review reads, folded: each PR's commits, then the ticket and its acceptance criteria as they were quoted. */
export const reviewedText = (message: AiReview): string => {
  const compared = message.pullRequests.map((pr) => t("task.agentMessage.aiReview.compared", { repo: pr.repo, n: pr.number, base: pr.base, head: pr.head }));
  const ticket =
    message.ticket === null
      ? [t("task.agentMessage.aiReview.noTicket")]
      : [`${message.ticket.key} ${message.ticket.title}`.trim(), ...(message.ticket.description.trim() === "" ? [] : [message.ticket.description])];
  const criteria = message.acceptanceCriteria === null ? [] : [`${t("task.agentMessage.aiReview.criteria")}\n${message.acceptanceCriteria}`];
  return [compared.join("\n"), ...ticket, ...criteria].join("\n\n");
};

/** The header's words for the message, after its time. */
export const agentMessageMark = (message: AgentMessage): string => {
  switch (message.kind) {
    case "pr-comment":
      return t("task.agentMessage.prComment");
    case "fix-checks":
      return plural(message.checks.length, "task.agentMessage.fixChecks.one", "task.agentMessage.fixChecks.other");
    case "update-branch":
      return t("task.agentMessage.updateBranch");
    case "keep-working":
      return t("task.agentMessage.keepWorking");
    case "plan-revision":
      return t("task.agentMessage.planRevision");
    case "fix-ci":
      return plural(message.checks.length, "task.agentMessage.fixCi.one", "task.agentMessage.fixCi.other");
    case "fix-findings": {
      const blocking = blockingOf(message).length;
      const nits = message.findings.length - blocking;
      const head = plural(blocking, "task.agentMessage.fixFindings.one", "task.agentMessage.fixFindings.other");
      return nits === 0 ? head : `${head}, ${plural(nits, "task.agentMessage.nits.one", "task.agentMessage.nits.other")}`;
    }
    case "changes-requested":
      return t("task.agentMessage.changesRequested");
    case "plan-approved":
      return message.edited ? t("task.agentMessage.planApprovedEdited") : t("task.agentMessage.planApproved");
    case "question-answer":
      return t("task.agentMessage.questionAnswer");
    case "approval-answer":
      return t(`task.agentMessage.approval.${message.decision}`);
    case "closing-turn":
      return t("task.agentMessage.closingTurn");
    case "ai-review":
      return `${t("task.agentMessage.aiReview.before")}${reviewedWords(message)}`;
    case "refine":
      return message.ticket.key === "" ? t("task.agentMessage.refine.markNoKey") : t("task.agentMessage.refine.mark", { key: message.ticket.key });
    case "quoted":
      return t(`taskAnswers.intent.${message.intent}`);
    default:
      return message satisfies never;
  }
};

/**
 * The tag after a bubble's time (parts.md part 2): `automatic` on what ostra sent by itself, `PR
 * comment` and `changes requested` on what came from GitHub, and the member's own presses in words
 * (`asked to fix 2 checks`, `asked for changes`). `null` for a late answer: it's a receipt.
 */
export const agentMessageTag = (message: AgentMessage): string | null => {
  switch (message.kind) {
    case "fix-ci":
    case "fix-findings":
    case "closing-turn":
    case "ai-review":
    case "refine":
      return t("task.bubble.automatic");
    case "pr-comment":
      return t("task.bubble.prComment");
    case "changes-requested":
      return t("task.bubble.changesRequested");
    case "fix-checks":
      return plural(message.checks.length, "task.bubble.fixChecks.one", "task.bubble.fixChecks.other");
    case "plan-revision":
      return t("task.bubble.askedForChanges");
    case "update-branch":
    case "keep-working":
      return agentMessageMark(message);
    case "quoted":
      return t(`taskAnswers.intent.${message.intent}`);
    case "plan-approved":
    case "question-answer":
    case "approval-answer":
      return null;
    default:
      return message satisfies never;
  }
};

const whereOf = (path: string, line: number | null): string => (line === null ? path : `${path}:${String(line)}`);

/** What it carried, as one plain text, for the subagents window's "Asked by" (F-138). */
export const agentMessageSummary = (message: AgentMessage): string => {
  const mark = agentMessageMark(message);
  const listed = (items: readonly string[]): string => (items.length === 0 ? mark : `${mark}: ${items.join(", ")}`);
  switch (message.kind) {
    case "pr-comment":
      return message.path === null ? message.text : `${whereOf(message.path, message.line)}\n${message.text}`;
    case "fix-checks":
      return listed(message.checks.map((check) => check.name ?? check.command));
    case "update-branch":
      return listed(message.repos.map((repo) => repo.repo));
    case "keep-working":
      return message.afterCap ? t("task.agentMessage.keepWorkingAfterCap") : t("task.agentMessage.keepWorkingBody");
    case "plan-revision":
      return message.request;
    case "fix-ci":
      return listed(message.checks.map((check) => check.name));
    case "fix-findings":
      return listed(blockingOf(message).map((finding) => finding.title));
    case "changes-requested":
      return message.review ?? `${mark}: ${plural(message.comments.length, "task.agentMessage.lineComments.one", "task.agentMessage.lineComments.other")}`;
    case "plan-approved":
      return mark;
    case "question-answer":
      return message.answers;
    case "approval-answer":
      return message.request === null ? mark : `${mark}: ${message.request}`;
    case "closing-turn":
      return t("task.agentMessage.closingTurnBody");
    case "ai-review":
      return listed(message.pullRequests.map((pr) => pr.repo));
    case "refine":
      return `${mark}: ${message.ticket.title}`;
    case "quoted":
      return message.blocks.map((block) => block.text).join("\n\n");
    default:
      return message satisfies never;
  }
};

// ---- the bubbles' bodies (milestone 10, F-151, parts.md part 2; ticket 12) --------------------

/** Long text folded under one line: a check's output. Closed until opened. */
const Folded = ({ summary, text }: { readonly summary: string; readonly text: string }) => (
  <details className="group mt-0.5">
    <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1 text-[13.5px] text-muted hover:text-text">
      <ChevronRightIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75] transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      {summary}
    </summary>
    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-[1.6] text-muted">{text}</pre>
  </details>
);

/** A round's head: `CI round 1 of 2` 600, then `--faint` ` · automatic turn 1 of 4`. */
const RoundHead = ({ title, turn }: { readonly title: string; readonly turn: string | null }) => (
  <p data-part="round-head">
    <span className="font-semibold">{title}</span>
    {turn === null ? null : <span className="text-faint"> · {turn}</span>}
  </p>
);

/** A failing job's or check's row, 24px: `x` red, its name mono, how it ended `--faint`, then its log. */
const FailingRow = ({ name, ended, log }: { readonly name: string; readonly ended: string | null; readonly log?: ReactNode }) => (
  <div data-item="check" className="flex min-h-6 items-baseline gap-2 text-ui">
    <XIcon aria-hidden className="size-[13px] shrink-0 self-center stroke-[1.75] text-red" />
    <span className="font-mono text-[13px] text-text [overflow-wrap:anywhere]">{name}</span>
    {ended === null ? null : <span className="text-[13.5px] text-faint">{ended}</span>}
    {log}
  </div>
);

/** How a job ended on its row: milestone 6's words. */
const jobEnded = (conclusion: string | null): string | null =>
  conclusion === "timed_out" ? t("review.round.timedOut") : conclusion === "cancelled" ? t("review.round.cancelled") : conclusion === null ? null : t("review.round.failed");

/** The round's hold, inside its bubble: `pause-circle` and milestone 6's held words, while held or once released. */
const HeldLine = ({ round }: { readonly round: RoundView["round"] }) => {
  const text =
    round.state === "held"
      ? round.heldReason?.scope === "organization"
        ? t("review.round.heldOrganization")
        : t("review.round.heldProject")
      : round.hold === null
        ? null
        : releasedHoldText(round.hold);
  return text === null ? null : (
    <p className="mt-1.5 flex items-start gap-[7px] text-[13px] leading-[1.45] text-faint" data-part="round-held">
      <PauseCircleIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75]" />
      <span>{text}</span>
    </p>
  );
};

/** The round's head words: its name of its limit and the automatic turn, once `tasks.rounds` is read. */
const roundHeadOf = (view: RoundView | null, fallback: string): { readonly title: string; readonly turn: string | null } =>
  view === null
    ? { title: fallback, turn: null }
    : { title: roundName(view.round, view.limits), turn: view.automaticTurn === null ? null : automaticTurnWords(view.automaticTurn, view.limits.automaticTurns, t) };

/** An AI review's body: what it reviews, its size and what it reads against, and `What the agent got ›`. */
const AiReviewBody = ({ message }: { readonly message: AiReview }) => {
  const [open, setOpen] = useState(false);
  const head = aiReviewHeadWords(message.pullRequests.map((pr) => pr.number), message.round, t);
  const reads = aiReviewReadsWords(
    {
      files: message.pullRequests.reduce((sum, pr) => sum + pr.files, 0),
      added: message.pullRequests.reduce((sum, pr) => sum + pr.additions, 0),
      removed: message.pullRequests.reduce((sum, pr) => sum + pr.deletions, 0),
      prs: message.pullRequests.length,
      ticketKey: message.ticket?.key ?? null,
      criteria: message.acceptanceCriteria !== null,
    },
    t,
  );
  return (
    <>
      <p>
        <span className="font-semibold">{head.title}</span>
        {head.round}
      </p>
      <p className="mt-[3px] text-[13.5px] leading-[1.5] text-faint" data-part="review-reads">
        <Segments segments={reads} mono="font-mono text-[12.5px]" />
      </p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen((now) => !now); }}
        className="mt-[5px] inline-flex items-center gap-0.5 text-[13.5px] text-teal hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
        data-action="what-the-agent-got"
      >
        {open ? t("task.bubble.aiReview.hideGot") : t("task.bubble.aiReview.got")}
        <ChevronRightIcon aria-hidden className={cn("size-[13px] stroke-[1.75]", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="mt-1.5" data-part="review-got">
          {message.pullRequests.length === 1 ? null : (
            <ul className="mb-1.5 flex flex-col gap-0.5 text-[13.5px]">
              {message.pullRequests.map((pr) => (
                <li key={`${pr.repo}#${String(pr.number)}`} data-item="pull-request" className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[13px] text-text [overflow-wrap:anywhere]">{pr.repo}</span>
                  <SafeLink href={pr.url ?? undefined}>{t("task.agentMessage.aiReview.pr", { n: pr.number })}</SafeLink>
                </li>
              ))}
            </ul>
          )}
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-[1.6] text-muted">{reviewedText(message)}</pre>
        </div>
      ) : null}
    </>
  );
};

/** A member's own words (and words a member wrote on Linear): Markdown as the agent's prose, no raw HTML, safe links. */
export const MemberWords = ({ text }: { readonly text: string }) => (
  <AgentMarkdown
    text={text}
    data-part="user-text"
    className={cn(
      "[&_:where(p,ul,ol,pre,blockquote)]:my-0 [&_:where(p,ul,ol,pre,blockquote)+:where(p,ul,ol,pre,blockquote)]:mt-1.5",
      "[&_:where(ul,ol)]:pl-5 [&_li+li]:mt-1 [&_li::marker]:text-faint [&_:where(strong,b)]:font-semibold",
      "[&_:not(pre)>code]:rounded-[5px] [&_:not(pre)>code]:border-line [&_:not(pre)>code]:bg-bg [&_:not(pre)>code]:px-[5px] [&_:not(pre)>code]:py-px [&_code]:text-[13px]",
    )}
  />
);

/** The body of a message ostra wrote for the agent: its data, never its prompt (parts.md part 2's table). */
export const AgentMessageBody = ({ message, round = null, taskId = null }: { readonly message: AgentMessage; readonly round?: RoundView | null; readonly taskId?: string | null }) => (
  <div data-part="agent-message" data-kind={message.kind}>
    <Body message={message} round={round} taskId={taskId} />
  </div>
);

const Body = ({ message, round, taskId }: { readonly message: AgentMessage; readonly round: RoundView | null; readonly taskId: string | null }) => {
  switch (message.kind) {
    case "pr-comment":
      return <Quoted place={message.path === null ? null : whereOf(message.path, message.line)}>{message.text}</Quoted>;
    case "fix-checks":
      return (
        <>
          {message.checks.map((check, index) => (
            <div key={index}>
              <FailingRow name={check.name ?? check.command} ended={check.status === null ? null : t(`task.agentMessage.checkStatus.${check.status}`)} />
              {check.name === null ? null : <div className="ml-[21px] font-mono text-[12.5px] text-faint [overflow-wrap:anywhere]">{`$ ${check.command}`}</div>}
              {check.output.trim() === "" ? null : (
                <div className="ml-[21px]">
                  <Folded summary={t("task.agentMessage.checkOutput")} text={check.output} />
                </div>
              )}
            </div>
          ))}
        </>
      );
    case "update-branch":
      return (
        <>
          {message.repos.map((repo) => (
            <p key={repo.repo} data-item="repo" className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-[13px] text-text [overflow-wrap:anywhere]">{repo.repo}</span>
              <span className="text-[13.5px] text-muted [overflow-wrap:anywhere]">
                {plural(repo.behindBy, "task.agentMessage.updateBranchRepo.one", "task.agentMessage.updateBranchRepo.other", { base: repo.base, branch: repo.branch })}
              </span>
            </p>
          ))}
        </>
      );
    case "keep-working":
    case "closing-turn":
      return <p className="whitespace-pre-wrap">{agentMessageSummary(message)}</p>;
    case "plan-revision":
      return <MemberWords text={message.request} />;
    case "fix-ci": {
      const head = roundHeadOf(round, plural(message.checks.length, "task.agentMessage.fixCi.one", "task.agentMessage.fixCi.other"));
      const failing = round !== null && round.round.cause.kind === "ci" && round.round.cause.failing.length > 0 ? round.round.cause.failing : null;
      return (
        <>
          <RoundHead title={head.title} turn={head.turn} />
          {failing === null
            ? message.checks.map((check, index) => <FailingRow key={index} name={check.name} ended={conclusionWords(check.conclusion)} />)
            : failing.slice(0, 5).map((check) => (
                <FailingRow
                  key={`${check.repo}-${check.name}`}
                  name={check.name}
                  ended={jobEnded(check.conclusion)}
                  log={
                    check.logFile === null || taskId === null ? (
                      <span className="text-[13.5px] text-faint">{t("review.round.noLog")}</span>
                    ) : (
                      <Link href={`/tasks/${taskId}?tab=checks`} title={`${CI_FILES_DIR}/${check.logFile}`} className="font-mono text-[13px] text-teal hover:underline" data-log={check.logFile}>
                        {t("task.bubble.log")}
                      </Link>
                    )
                  }
                />
              ))}
          {failing !== null && failing.length > 5 ? <p className="text-[13px] text-faint">{t("review.round.notSent", { n: failing.length - 5 })}</p> : null}
          {failing === null && message.checks.length === 0 ? <p className="text-[13.5px] text-faint">{t("review.round.noFailing")}</p> : null}
          {round === null ? null : <HeldLine round={round.round} />}
        </>
      );
    }
    case "fix-findings": {
      const head = roundHeadOf(round, agentMessageMark(message));
      return (
        <>
          <RoundHead title={head.title} turn={head.turn} />
          <p className="text-ui text-faint" data-part="findings-sent">
            <Segments segments={findingsSentSegments(message.findings, t)} />
          </p>
          {round === null ? null : <HeldLine round={round.round} />}
        </>
      );
    }
    case "changes-requested":
      return (
        <>
          {message.review === null ? null : <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.review}</p>}
          {message.comments.map((comment, index) => (
            <Quoted key={index} data-item="review-comment" place={comment.location === "" ? null : comment.location}>
              {comment.body}
            </Quoted>
          ))}
          {round === null ? null : <HeldLine round={round.round} />}
        </>
      );
    case "plan-approved":
    case "question-answer":
    case "approval-answer":
      // A late answer is its receipt, never a bubble (`thread/receipt.tsx`); these words are for the subagents window.
      return <p className="whitespace-pre-wrap">{agentMessageSummary(message)}</p>;
    case "ai-review":
      return <AiReviewBody message={message} />;
    case "refine":
      return (
        <p>
          <span className="font-semibold">{message.ticket.key === "" ? t("task.agentMessage.refine.markNoKey") : t("task.agentMessage.refine.mark", { key: message.ticket.key })}</span>
          {`: ${message.ticket.title}`}
        </p>
      );
    case "quoted":
      return (
        <>
          {message.blocks.map((block, index) => (
            <Quoted key={index} data-item={block.label} place={block.label}>
              {block.text}
            </Quoted>
          ))}
        </>
      );
    default:
      return message satisfies never;
  }
};

/**
 * A member message's body. Diff comments show the comments they carried (by `diffSeq`, the
 * sequence of the message that sent them); a message ostra wrote for the agent, its data; a
 * member's own, their words as Markdown.
 */
export const UserMessageText = ({
  text,
  intent,
  diffSeq,
  agentMessage,
  round = null,
  taskId = null,
}: {
  readonly text: string;
  readonly intent: MessageIntent | undefined;
  readonly diffSeq: number | undefined;
  readonly agentMessage: AgentMessage | null;
  readonly round?: RoundView | null;
  readonly taskId?: string | null;
}) =>
  intent === "diff-comments" ? (
    <SentDiffCommentsList seq={diffSeq} />
  ) : agentMessage !== null ? (
    <AgentMessageBody message={agentMessage} round={round} taskId={taskId} />
  ) : (
    <MemberWords text={text} />
  );

