import { createContext, useContext } from "react";

import type { MessageIntent } from "@ostra/protocol";

import { cn } from "@/lib/cn";
import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

// F-072 (ticket 46; task-changes.md, "In the Activity tab"): "Send N comments to the agent" writes one
// member message whose text is the agent's prompt, each comment fenced as data. That text is for the
// agent only: the thread draws the message from the comments it carried, the rows whose `sentInSeq`
// is the message's sequence (`diff.comments.list`). Its header reads `{n} comments on the diff`
// after the time, and its body lists each `{path}:{line}`, the quoted line and the comment, as plain text.

type ApiComment = RouterOutputs["diff"]["comments"]["list"]["comments"][number];

/** A sent comment, as the thread draws it. */
export type SentDiffComment = Pick<ApiComment, "commentId" | "path" | "line" | "quoted" | "body">;

/** The sent comments by the sequence of the message that carried them; `null` until they're read. */
export type SentDiffComments = ReadonlyMap<number, readonly SentDiffComment[]> | null;

/** Groups the listed comments by the message that carried them. Drafts carry none, so they're left out. */
export const sentBySeq = (comments: readonly Pick<ApiComment, keyof SentDiffComment | "sentInSeq">[]): ReadonlyMap<number, readonly SentDiffComment[]> => {
  const bySeq = new Map<number, SentDiffComment[]>();
  for (const { sentInSeq, commentId, path, line, quoted, body } of comments) {
    if (sentInSeq === null) continue;
    const list = bySeq.get(sentInSeq) ?? [];
    list.push({ commentId, path, line, quoted, body });
    bySeq.set(sentInSeq, list);
  }
  return bySeq;
};

export const SentDiffCommentsContext = createContext<SentDiffComments>(null);

/** The comments the message at `seq` carried: `null` until they're read, or when there's no `seq`. */
const useSentAt = (seq: number | undefined): readonly SentDiffComment[] | null => {
  const sent = useContext(SentDiffCommentsContext);
  return sent === null || seq === undefined ? null : (sent.get(seq) ?? []);
};

/** The sign before a quoted line: `+` added, `−` (U+2212) removed, nothing for context. */
const signOf = (kind: NonNullable<SentDiffComment["quoted"]>["kind"]): string => {
  switch (kind) {
    case "add":
      return "+ ";
    case "del":
      return "− ";
    case "context":
      return "";
    default:
      return kind satisfies never;
  }
};

/**
 * A member message's intent in its header, after the time. Diff comments read ` · {n} comments on the
 * diff` once their comments are read; until then, and for any other intent, the intent's tag.
 */
export const MessageIntentMark = ({ intent, seq }: { readonly intent: Exclude<MessageIntent, "message">; readonly seq: number | undefined }) => {
  const sent = useSentAt(intent === "diff-comments" ? seq : undefined);
  if (sent !== null && sent.length > 0) {
    return (
      <span className="font-mono text-sm text-faint" data-tag="intent" data-intent={intent}>
        <span> · </span>
        {plural(sent.length, "task.diffComments.one", "task.diffComments.other")}
      </span>
    );
  }
  // Diff comments sit right after the time, in its span: the tag keeps the header's gap by itself.
  return (
    <span className={cn("rounded-sm border border-line-2 px-1.5 text-xs text-muted", intent === "diff-comments" && "ml-2")} data-tag="intent" data-intent={intent}>
      {t(`taskAnswers.intent.${intent}`)}
    </span>
  );
};

/** The comments a diff-comments message carried: each one's `{path}:{line}`, the quoted line and its text. */
export const SentDiffCommentsList = ({ seq }: { readonly seq: number | undefined }) => {
  const sent = useSentAt(seq);
  if (sent === null || sent.length === 0) return null;
  return (
    <ol data-part="diff-comments" className="mt-1 flex flex-col gap-2">
      {sent.map((comment) => (
        <li key={comment.commentId} data-diff-comment={comment.commentId} className="border-l-2 border-line-2 pl-3">
          <div className="font-mono text-xs text-muted [overflow-wrap:anywhere]">{`${comment.path}:${String(comment.line)}`}</div>
          {comment.quoted === null || comment.quoted.text.trim() === "" ? null : (
            <div className="whitespace-pre-wrap font-mono text-xs text-faint [overflow-wrap:anywhere]">
              {signOf(comment.quoted.kind)}
              {comment.quoted.text}
            </div>
          )}
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</p>
        </li>
      ))}
    </ol>
  );
};

/**
 * A member message's text. A diff-comments message never shows its own: that's the fenced prompt
 * the agent reads. It shows the comments it carried instead.
 */
export const UserMessageText = ({ text, intent, seq }: { readonly text: string; readonly intent: MessageIntent | undefined; readonly seq: number | undefined }) =>
  intent === "diff-comments" ? (
    <SentDiffCommentsList seq={seq} />
  ) : (
    <p data-part="user-text" className="whitespace-pre-wrap break-words">
      {text}
    </p>
  );
