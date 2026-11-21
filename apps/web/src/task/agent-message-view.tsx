import { ChevronRightIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { readAgentMessage } from "@ostra/domain/agent-message";
import type { AgentMessage } from "@ostra/domain/agent-message";
import type { MessageIntent } from "@ostra/protocol";
import type { TaskUIMessage } from "@ostra/task-view";

import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";

import { SentDiffCommentsList } from "./diff-comments-message";
import { SafeLink } from "./renderers";

// The thread's member messages that ostra wrote for the agent (F-072's fix for diff comments, for
// every kind): their text is the agent's prompt, ostra's instructions around marked blocks, so the
// thread never draws it. `readAgentMessage` (`@ostra/domain/agent-message`) reads the blocks' data
// and the facts ostra's lines carry; this draws them as a short mark after the header's time and a
// body of plain text. Every piece of quoted text (a comment, a check's output, a finding, a
// member's request) is a React text node, escaped, never HTML. A member's own text stays as typed.

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

/** The folded summary's line: the change's size in all, and which review this is when it isn't the first. */
const reviewedSummary = (message: AiReview): string => {
  const files = message.pullRequests.reduce((sum, pr) => sum + pr.files, 0);
  const added = message.pullRequests.reduce((sum, pr) => sum + pr.additions, 0);
  const removed = message.pullRequests.reduce((sum, pr) => sum + pr.deletions, 0);
  const size = `${plural(files, "task.agentMessage.aiReview.files.one", "task.agentMessage.aiReview.files.other")}, ${t("task.agentMessage.aiReview.lines", { added, removed })}`;
  return message.round.number > 1 ? `${size} · ${t("task.agentMessage.aiReview.round", { n: message.round.number, of: message.round.of })}` : size;
};

/** What the review reads, folded: each PR's commits, then the ticket and its acceptance criteria as they were quoted. */
const reviewedText = (message: AiReview): string => {
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

/** The mark after the header's time: ` · {words}`, in the header's mono `--faint`. An AI review's one PR links to it. */
export const AgentMessageMark = ({ message, intent }: { readonly message: AgentMessage; readonly intent: MessageIntent | undefined }) => {
  const only = message.kind === "ai-review" ? onlyPullRequest(message) : null;
  return (
    <span className="font-mono text-sm text-faint" data-tag="intent" data-intent={intent ?? "message"} data-agent-message={message.kind}>
      <span> · </span>
      {message.kind === "ai-review" && only !== null && only.url !== null ? (
        <>
          {t("task.agentMessage.aiReview.before")}
          <SafeLink href={only.url}>{reviewedWords(message)}</SafeLink>
        </>
      ) : (
        agentMessageMark(message)
      )}
    </span>
  );
};

/** A Linear follow-up's mark: the member's own words came from a comment on the task's ticket. */
export const LinearMark = ({ ticketKey }: { readonly ticketKey: string | undefined }) => (
  <span className="font-mono text-sm text-faint" data-tag="intent" data-intent="linear-follow-up">
    <span> · </span>
    {ticketKey === undefined ? t("task.agentMessage.linearCommentNoKey") : t("task.agentMessage.linearComment", { key: ticketKey })}
  </span>
);

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

/** A place in the code, or a block's label: mono 12px `--muted`. */
const Where = ({ children }: { readonly children: string }) => <div className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{children}</div>;

/** Quoted text, as it was written: plain, its lines kept. */
const Words = ({ children, className }: { readonly children: string; readonly className?: string }) => (
  <p className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>{children}</p>
);

/** One quoted item of a list: the thread's rule on its left (as a sent diff comment's). */
const Item = ({ children, ...data }: { readonly children: ReactNode; readonly "data-item"?: string }) => (
  <li {...data} className="border-l-2 border-line-2 pl-3">
    {children}
  </li>
);

/** Long text folded under one line: a check's output, a plan. Closed until opened. */
const Folded = ({ summary, text }: { readonly summary: string; readonly text: string }) => (
  <details className="group mt-0.5">
    <summary className="flex min-h-6 cursor-pointer list-none items-center gap-1 text-sm text-muted hover:text-text">
      <ChevronRightIcon className="size-[13px] shrink-0 stroke-[1.75] transition-transform group-open:rotate-90" />
      {summary}
    </summary>
    <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-[1.6] text-muted">{text}</pre>
  </details>
);

const List = ({ children, ordered = false }: { readonly children: ReactNode; readonly ordered?: boolean }) =>
  ordered ? <ol className="flex flex-col gap-2">{children}</ol> : <ul className="flex flex-col gap-2">{children}</ul>;

/** The body of a message ostra wrote for the agent: its data, never its prompt. */
export const AgentMessageBody = ({ message }: { readonly message: AgentMessage }) => (
  <div data-part="agent-message" data-kind={message.kind} className="mt-1 flex flex-col gap-1.5">
    <Body message={message} />
  </div>
);

const Body = ({ message }: { readonly message: AgentMessage }) => {
  switch (message.kind) {
    case "pr-comment":
      return (
        <>
          {message.path === null ? null : <Where>{whereOf(message.path, message.line)}</Where>}
          <Words>{message.text}</Words>
        </>
      );
    case "fix-checks":
      return (
        <List ordered>
          {message.checks.map((check, index) => (
            <Item key={index} data-item="check">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-sm text-text [overflow-wrap:anywhere]">{check.name ?? check.command}</span>
                {check.status === null ? null : <span className="text-sm text-red">{t(`task.agentMessage.checkStatus.${check.status}`)}</span>}
              </div>
              {check.name === null ? null : <Where>{`$ ${check.command}`}</Where>}
              {check.output.trim() === "" ? null : <Folded summary={t("task.agentMessage.checkOutput")} text={check.output} />}
            </Item>
          ))}
        </List>
      );
    case "update-branch":
      return (
        <List>
          {message.repos.map((repo) => (
            <li key={repo.repo} data-item="repo" className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-mono text-text [overflow-wrap:anywhere]">{repo.repo}</span>
              <span className="text-muted [overflow-wrap:anywhere]">
                {plural(repo.behindBy, "task.agentMessage.updateBranchRepo.one", "task.agentMessage.updateBranchRepo.other", { base: repo.base, branch: repo.branch })}
              </span>
            </li>
          ))}
        </List>
      );
    case "keep-working":
    case "closing-turn":
      return <Words className="text-muted">{agentMessageSummary(message)}</Words>;
    case "plan-revision":
      return <Words>{message.request}</Words>;
    case "fix-ci":
      return (
        <List>
          {message.checks.map((check, index) => {
            const conclusion = conclusionWords(check.conclusion);
            return (
              <li key={index} data-item="check" className="flex items-baseline gap-2 text-sm">
                <XIcon aria-hidden className="size-[13px] shrink-0 self-center stroke-[1.75] text-red" />
                <span className="font-mono text-text [overflow-wrap:anywhere]">{check.name}</span>
                {conclusion === null ? null : <span className="text-faint">{conclusion}</span>}
              </li>
            );
          })}
        </List>
      );
    case "fix-findings":
      return (
        <List ordered>
          {message.findings.map((finding, index) => (
            <Item key={index} data-item={finding.severity}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cn("rounded-sm border border-line-2 px-1.5 text-xs", finding.severity === "blocking" ? "text-red" : "text-muted")}>
                  {t(`task.agentMessage.severity.${finding.severity}`)}
                </span>
                <span className="font-semibold [overflow-wrap:anywhere]">{finding.title}</span>
              </div>
              <Where>{finding.location}</Where>
              {finding.body.trim() === "" ? null : <Words className="text-muted">{finding.body}</Words>}
            </Item>
          ))}
        </List>
      );
    case "changes-requested":
      return (
        <>
          {message.review === null ? null : <Words>{message.review}</Words>}
          {message.comments.length === 0 ? null : (
            <List ordered>
              {message.comments.map((comment, index) => (
                <Item key={index} data-item="review-comment">
                  {comment.location === "" ? null : <Where>{comment.location}</Where>}
                  <Words>{comment.body}</Words>
                </Item>
              ))}
            </List>
          )}
        </>
      );
    case "plan-approved":
      return <Folded summary={t("task.agentMessage.planShown")} text={message.plan} />;
    case "question-answer":
      return (
        <>
          <Words className="border-l-2 border-line-2 pl-3 text-muted">{message.question}</Words>
          <Words>{message.answers}</Words>
        </>
      );
    case "approval-answer":
      return (
        <>
          {message.request === null ? null : <Where>{message.request}</Where>}
          {message.reason === null ? null : <Words>{message.reason}</Words>}
        </>
      );
    case "ai-review":
      return (
        <>
          <List>
            {message.pullRequests.map((pr) => (
              <li key={`${pr.repo}#${String(pr.number)}`} data-item="pull-request" className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-mono text-text [overflow-wrap:anywhere]">{pr.repo}</span>
                <span className="font-mono text-muted [overflow-wrap:anywhere]">{pr.branch}</span>
                {message.pullRequests.length === 1 ? null : <SafeLink href={pr.url ?? undefined}>{t("task.agentMessage.aiReview.pr", { n: pr.number })}</SafeLink>}
              </li>
            ))}
          </List>
          <Folded summary={reviewedSummary(message)} text={reviewedText(message)} />
        </>
      );
    case "refine":
      return (
        <>
          <Words className="font-semibold">{message.ticket.title}</Words>
          {message.repos.length === 0 ? null : (
            <List>
              {message.repos.map((repo) => (
                <li key={repo} data-item="repo" className="font-mono text-sm text-text [overflow-wrap:anywhere]">
                  {repo}
                </li>
              ))}
            </List>
          )}
          {message.ticket.description.trim() === "" ? null : <Folded summary={t("task.agentMessage.refine.description")} text={message.ticket.description} />}
        </>
      );
    case "quoted":
      return (
        <List ordered>
          {message.blocks.map((block, index) => (
            <Item key={index} data-item={block.label}>
              <Where>{block.label}</Where>
              <Words>{block.text}</Words>
            </Item>
          ))}
        </List>
      );
    default:
      return message satisfies never;
  }
};

/**
 * A member message's text. Diff comments show the comments they carried (by `diffSeq`, the
 * sequence of the message that sent them); a message ostra wrote for the agent, its data; a
 * member's own, the text as typed.
 */
export const UserMessageText = ({
  text,
  intent,
  diffSeq,
  agentMessage,
}: {
  readonly text: string;
  readonly intent: MessageIntent | undefined;
  readonly diffSeq: number | undefined;
  readonly agentMessage: AgentMessage | null;
}) =>
  intent === "diff-comments" ? (
    <SentDiffCommentsList seq={diffSeq} />
  ) : agentMessage !== null ? (
    <AgentMessageBody message={agentMessage} />
  ) : (
    <p data-part="user-text" className="whitespace-pre-wrap break-words">
      {text}
    </p>
  );
