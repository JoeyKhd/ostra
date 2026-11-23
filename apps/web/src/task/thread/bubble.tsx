"use client";

import type { AgentMessage } from "@ostra/domain/agent-message";
import type { TaskUIMessage } from "@ostra/task-view";

import { ThreadMessageFiles } from "@/components/tasks/attachments/thread-files";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";

import { AgentMessageMark, isAutomatic, LinearMark, UserMessageText } from "../agent-message-view";
import { MessageIntentMark } from "../diff-comments-message";
import { useTaskContext } from "../task-context";

// Owner: ticket 12 (milestone 10, F-151: a member's message, parts.md part 2). Ticket 09's stub, with
// its final props: a right-aligned bubble with the name and the time over it (choice 11), filled
// when a person typed it here and outlined when ostra sent it by itself (choice 6), its files
// above it, and milestone 1 to 9's tags and bodies as they were. Ticket 12 restyles each kind.

/** One `--faint` tag after the time (`queued`, `after an interrupt`, `sending…`). */
const Tag = ({ children, tone = "faint", testid, tag }: { readonly children: string; readonly tone?: "faint" | "red"; readonly testid?: string; readonly tag?: string }) => (
  <span className={cn("text-[12.5px]", tone === "red" ? "text-red" : "text-faint")} data-testid={testid} data-tag={tag}>
    · {children}
  </span>
);

export const Bubble = ({ message, agentMessage }: { readonly message: TaskUIMessage; readonly agentMessage: AgentMessage | null }) => {
  const { memberName, ticketKey } = useTaskContext();
  const meta = message.metadata;
  const author = meta?.author;
  const intent = author?.intent;
  const automatic = agentMessage !== null && isAutomatic(agentMessage);
  const name = automatic ? t("task.agentMessage.ostra") : author === undefined ? "" : memberName(author.memberId);
  const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const files = message.parts.find((part) => part.type === "data-message-files");
  return (
    <div data-part="bubble" data-automatic={automatic ? "true" : undefined} className="mb-[18px] mt-6 flex flex-col items-end">
      <div className="mx-1 mb-[5px] flex min-w-0 flex-wrap items-baseline justify-end gap-x-1.5 text-[12.5px] text-faint">
        <span className="font-medium text-muted">{name}</span>
        {meta?.at === undefined ? null : <span className="font-mono text-xs">{formatClock(meta.at)}</span>}
        {intent === "diff-comments" ? (
          <MessageIntentMark intent={intent} seq={author?.replayOf ?? meta?.firstSeq} />
        ) : agentMessage !== null ? (
          <AgentMessageMark message={agentMessage} intent={intent} />
        ) : intent === "linear-follow-up" ? (
          <LinearMark ticketKey={ticketKey} />
        ) : intent === undefined || intent === "message" ? null : (
          <MessageIntentMark intent={intent} seq={meta?.firstSeq} />
        )}
        {author?.held === true ? <Tag tone="red" testid="message-held">{t("task.held")}</Tag> : author?.delivery === "queued" ? <Tag>{t("task.queued")}</Tag> : null}
        {author?.delivery === "after-interrupt" ? <Tag>{t("task.afterInterrupt")}</Tag> : null}
        {author?.reopen === true ? <Tag tag="reopen">{t("task.reopenTag")}</Tag> : null}
        {author?.replayed === true ? <Tag tag="replayed">{t("task.replayedTag")}</Tag> : null}
        {meta?.optimistic === true ? <Tag>{t("task.sending")}</Tag> : null}
      </div>
      {files?.type === "data-message-files" ? (
        <div className="mb-1.5 flex max-w-[82%] flex-col items-end">
          <ThreadMessageFiles data={files.data} author={author === undefined ? "" : memberName(author.memberId)} />
        </div>
      ) : null}
      {text === "" && agentMessage === null && intent !== "diff-comments" ? null : (
        <div
          className={cn(
            "max-w-[82%] rounded-2xl px-3.5 pb-2.5 pt-[9px] text-body leading-[1.55] text-text",
            automatic ? "border border-line-2" : "bg-sel",
          )}
        >
          <UserMessageText text={text} intent={intent} diffSeq={author?.replayOf ?? meta?.firstSeq} agentMessage={agentMessage} />
        </div>
      )}
    </div>
  );
};
