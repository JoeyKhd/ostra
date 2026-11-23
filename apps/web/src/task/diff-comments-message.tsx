import { createContext, useContext } from "react";

import { plural, t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { Quoted } from "./thread/quoted";

// F-072 (ticket 46; task-changes.md, "In the Activity tab"): "Send N comments to the agent" writes one
// member message whose text is the agent's prompt, each comment fenced as data. That text is for the
// agent only: the thread draws the message from the comments it carried, the rows whose `sentInSeq`
// is the message's sequence (`diff.comments.list`). Its bubble's tag reads `{n} comments on the
// diff` after the time, and its body quotes each `{path}:{line}`, the quoted line and the comment,
// as plain text (milestone 10, parts.md part 2).
// Every other message ostra writes for the agent is drawn by `agent-message-view.tsx`.

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
 * A diff-comments message's tag after its time (parts.md part 2): `{n} comments on the diff` once
 * its comments are read; until then, the intent's words.
 */
export const useDiffCommentsTag = (seq: number | undefined): string => {
  const sent = useSentAt(seq);
  return sent !== null && sent.length > 0 ? plural(sent.length, "task.diffComments.one", "task.diffComments.other") : t("taskAnswers.intent.diff-comments");
};

/**
 * The comments a diff-comments message carried, each a quoted item in the bubble: its
 * `{path}:{line}`, the quoted line (mono `--muted`, one line) and the comment.
 */
export const SentDiffCommentsList = ({ seq }: { readonly seq: number | undefined }) => {
  const sent = useSentAt(seq);
  if (sent === null || sent.length === 0) return null;
  return (
    <div data-part="diff-comments">
      {sent.map((comment) => (
        <Quoted
          key={comment.commentId}
          data-diff-comment={comment.commentId}
          place={`${comment.path}:${String(comment.line)}`}
          line={comment.quoted === null || comment.quoted.text.trim() === "" ? null : `${signOf(comment.quoted.kind)}${comment.quoted.text}`}
        >
          {comment.body}
        </Quoted>
      ))}
    </div>
  );
};
