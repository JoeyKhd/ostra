"use client";

import type { ReactNode } from "react";

import type { AgentMessage } from "@ostra/domain/agent-message";
import { clientMessageIdSchema } from "@ostra/protocol";
import type { MessageIntent } from "@ostra/protocol";
import type { TaskUIMessage } from "@ostra/task-view";

import { ThreadMessageFiles } from "@/components/tasks/attachments/thread-files";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";

import { agentMessageTag, isAutomatic, UserMessageText } from "../agent-message-view";
import { useDiffCommentsTag } from "../diff-comments-message";
import { useTaskContext } from "../task-context";
import { Divider } from "./divider";
import { PrCommentLinks, usePrCommentOf, useRememberThis } from "./pr-comment";
import { Quoted } from "./quoted";
import { AnswerReceipt } from "./receipt";
import { useRoundOf } from "./round-of";
import { useThreadParts } from "./thread-context";
import { githubAuthorWords } from "./words";

// Owner: ticket 12 (milestone 10, F-151: a member's message, parts.md part 2). A right-aligned
// bubble with the name, the time and its tags over it (choice 11: always), its files above it.
// Filled (`--sel`) when a person typed it here; outlined (a 1px `--line-2` edge, no fill) when
// ostra sent it by itself (`ostra · automatic`: a round, an AI review, a refine task's start, the
// closing turn) or it came from GitHub (`{login} on GitHub`: an `@ostra` comment, changes
// requested) (choice 6). A Linear follow-up is a member's words, so it's filled. What a message
// carries for the agent is drawn from its data, never its prompt; a late answer is its receipt.

type LateAnswer = Extract<AgentMessage, { readonly kind: "plan-approved" | "question-answer" | "approval-answer" }>;

/** An answer sent as a reopen once the box was gone: drawn as its receipt, never a bubble (content fix 10). */
const isLateAnswer = (message: AgentMessage | null): message is LateAnswer =>
  message?.kind === "plan-approved" || message?.kind === "question-answer" || message?.kind === "approval-answer";

/** One tag after the time, 12.5px `--faint` (`held` `--red`): ` · {tag}`. */
const Tag = ({ children, tone = "faint", testid, tag }: { readonly children: ReactNode; readonly tone?: "faint" | "red"; readonly testid?: string; readonly tag: string }) => (
  <span className="text-[12.5px] text-faint" data-tag={tag}>
    {"· "}
    <span className={cn(tone === "red" && "text-red")} data-testid={testid}>
      {children}
    </span>
  </span>
);

/** The words after the time for why the message was written (parts.md part 2's tags), or `null`. */
const useIntentTag = (message: TaskUIMessage, agentMessage: AgentMessage | null, intent: MessageIntent | undefined): string | null => {
  const { ticketKey } = useTaskContext();
  const meta = message.metadata;
  const diffComments = useDiffCommentsTag(intent === "diff-comments" ? (meta?.author?.replayOf ?? meta?.firstSeq) : undefined);
  switch (intent) {
    case "diff-comments":
      return diffComments;
    case "pr-comment":
      return t("task.bubble.prComment");
    case "changes-requested":
      return t("task.bubble.changesRequested");
    case "linear-follow-up":
      return ticketKey === undefined ? t("task.bubble.linearCommentNoKey") : t("task.bubble.linearComment", { key: ticketKey });
    case "plan-revision":
      return t("task.bubble.askedForChanges");
    case "fix-ci":
    case "fix-findings":
      return t("task.bubble.automatic");
    case "fix-checks":
      return agentMessage?.kind === "fix-checks" ? plural(agentMessage.checks.length, "task.bubble.fixChecks.one", "task.bubble.fixChecks.other") : t(`taskAnswers.intent.${intent}`);
    case "update-branch":
    case "keep-working":
    case "ticket-update":
      return agentMessage === null ? t(`taskAnswers.intent.${intent}`) : agentMessageTag(agentMessage);
    case "message":
    case undefined:
      return agentMessage === null ? null : agentMessageTag(agentMessage);
    default:
      return intent satisfies never;
  }
};

/** The message as its bubble: the line over it, its files, the bubble and, for a PR comment, its links. */
const MessageBubble = ({ message, agentMessage }: { readonly message: TaskUIMessage; readonly agentMessage: AgentMessage | null }) => {
  const { memberName } = useTaskContext();
  const { workspace } = useThreadParts();
  const meta = message.metadata;
  const author = meta?.author;
  const intent = author?.intent;
  const fromGitHub = intent === "pr-comment" || intent === "changes-requested";
  const automatic = agentMessage !== null && isAutomatic(agentMessage);
  const outlined = automatic || fromGitHub;
  const comment = usePrCommentOf(message);
  const github = fromGitHub ? comment : null;
  const remember = useRememberThis(intent === "pr-comment" ? github : null);
  const round = useRoundOf(message);
  const tag = useIntentTag(message, agentMessage, intent);
  const name = automatic ? t("task.agentMessage.ostra") : fromGitHub ? githubAuthorWords(github?.login ?? null, t) : author === undefined ? "" : memberName(author.memberId);
  const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const files = message.parts.find((part) => part.type === "data-message-files");
  const diffSeq = author?.replayOf ?? meta?.firstSeq;
  // An `@ostra` comment this version can't read as ostra's prompt is still the comment: its words, where it was.
  const place = github?.path === null || github?.path === undefined ? null : github.line === null ? github.path : `${github.path}:${String(github.line)}`;
  const body =
    intent === "pr-comment" && agentMessage?.kind !== "pr-comment" ? (
      <Quoted place={place}>{text}</Quoted>
    ) : (
      <UserMessageText text={text} intent={intent} diffSeq={diffSeq} agentMessage={agentMessage} round={round} taskId={workspace.taskId} />
    );
  const empty = text === "" && agentMessage === null && intent !== "diff-comments";
  return (
    <div
      data-part="bubble"
      data-look={outlined ? "outlined" : "filled"}
      data-from={automatic ? "ostra" : fromGitHub ? "github" : "member"}
      data-kind={agentMessage?.kind ?? intent ?? "message"}
      data-automatic={automatic ? "true" : undefined}
      data-round={round?.round.kind}
      data-number={round?.round.number}
      className="mb-[18px] mt-6 flex flex-col items-end"
    >
      <div className="mx-1 mb-[5px] flex min-w-0 max-w-full flex-wrap items-baseline justify-end gap-x-1.5 text-[12.5px] text-faint" data-part="bubble-by">
        <span className="font-medium text-muted" data-part="bubble-name">{name}</span>
        {meta?.at === undefined ? null : <span className="font-mono text-xs">{formatClock(meta.at)}</span>}
        {tag === null ? null : <Tag tag="intent">{tag}</Tag>}
        {author?.held === true ? (
          <Tag tag="held" tone="red" testid="message-held">{t("task.held")}</Tag>
        ) : author?.deliveryState === "queued" || (author?.deliveryState === undefined && author?.delivery === "queued") ? (
          <Tag tag="queued">{t("task.queued")}</Tag>
        ) : null}
        {author?.delivery === "after-interrupt" ? <Tag tag="after-interrupt">{t("task.afterInterrupt")}</Tag> : null}
        {author?.reopen === true ? <Tag tag="reopen">{t("task.reopenTag")}</Tag> : null}
        {author?.replayed === true ? <Tag tag="replayed">{t("task.replayedTag")}</Tag> : null}
        {meta?.optimistic === true ? <Tag tag="sending">{t("task.sending")}</Tag> : null}
      </div>
      {files?.type === "data-message-files" ? (
        <div className="mb-1.5 flex max-w-[82%] flex-col items-end max-sm:max-w-[88%]" data-part="bubble-files">
          <ThreadMessageFiles data={files.data} author={author === undefined ? "" : memberName(author.memberId)} />
        </div>
      ) : null}
      {empty ? null : (
        <div
          data-part="bubble-box"
          className={cn("min-w-0 max-w-[82%] rounded-2xl px-3.5 pb-2.5 pt-[9px] text-body leading-[1.55] text-text [overflow-wrap:anywhere] max-sm:max-w-[88%] max-sm:text-[15px]", outlined ? "border border-line-2" : "bg-sel")}
        >
          {intent === "pr-comment" ? (
            <div data-part="pr-comment" data-seq={github?.seq}>
              {body}
              {github === null ? null : <PrCommentLinks comment={github} onRemember={remember.onRemember} remembered={remember.remembered} />}
            </div>
          ) : (
            body
          )}
        </div>
      )}
      {remember.form}
    </div>
  );
};

export const Bubble = ({ message, agentMessage }: { readonly message: TaskUIMessage; readonly agentMessage: AgentMessage | null }) => {
  const { answers, runnerOf } = useThreadParts();
  // A reopen: how its session came back stands before it (parts.md part 12), though the log writes it after.
  const id = clientMessageIdSchema.safeParse(message.id.replace(/^user:/, ""));
  const restored = id.success ? answers?.restoredBefore.get(id.data) : undefined;
  const at = message.metadata?.at ?? 0;
  return (
    <>
      {restored === undefined ? null : <Divider divider={{ kind: "restored", event: restored, runner: runnerOf?.(message.metadata?.sessionId) ?? null }} now={at} />}
      {isLateAnswer(agentMessage) ? <AnswerReceipt message={message} answer={agentMessage} /> : <MessageBubble message={message} agentMessage={agentMessage} />}
    </>
  );
};
