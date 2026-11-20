"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { diffCommentIdSchema, gitShaSchema, taskRepoIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";

import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import type { SaveResult } from "./diff-view";
import type { CommentTarget, DiffCommentView, DiffFileView, DiffHunk, DiffLine, DiffRepoView, SendDelivery } from "./diff-words";
import { ChangesBody } from "./task-changes";
import type { PressState } from "./task-changes";

// Ticket 46 wired (task-changes.md; F-027, F-072, F-070): `diff.get` and `diff.comments.*` drawn by
// the Changes tab's parts, and "Update branch" through `tasks.updateBranch`. The API's shapes are
// read here once; the parts take the panel's own view of them.

type DiffOutput = RouterOutputs["diff"]["get"];
type ApiRepo = DiffOutput["repos"][number];
type ApiFile = ApiRepo["files"][number];
type ApiComment = RouterOutputs["diff"]["comments"]["list"]["comments"][number];

const linesOf = (hunk: ApiFile["hunks"][number]): readonly DiffLine[] =>
  hunk.lines.map((line): DiffLine => {
    switch (line.kind) {
      case "context":
        return { kind: "context", old: line.oldLine, new: line.newLine, text: line.text };
      case "add":
        return { kind: "add", new: line.newLine, text: line.text };
      case "del":
        return { kind: "del", old: line.oldLine, text: line.text };
      default:
        return line satisfies never;
    }
  });

const hunksOf = (file: ApiFile): readonly DiffHunk[] => {
  let previousEnd = 0;
  return file.hunks.map((hunk, index) => {
    const gap = hunk.oldStart - 1 - previousEnd;
    previousEnd = hunk.oldStart + hunk.oldLines - 1;
    const lines = linesOf(hunk);
    const last = index === file.hunks.length - 1 && file.newNoNewlineAtEnd ? [...lines, { kind: "no-newline" } as const] : lines;
    return { header: hunk.header, gapBefore: gap > 0 ? gap : null, lines: last };
  });
};

/** One file as the diff view draws it; a file the diff can't draw links to the code host. */
export const fileViewOf = (file: ApiFile, hostUrl: string | null): DiffFileView => ({
  path: file.path,
  previousPath: file.previousPath,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  body:
    file.kind === "text"
      ? { kind: "hunks", hunks: hunksOf(file) }
      : file.kind === "binary"
        ? { kind: "binary", url: hostUrl ?? "" }
        : file.kind === "too-large"
          ? { kind: "too-large", url: hostUrl ?? "" }
          : { kind: "renamed-only" },
});

export const repoViewOf = (repo: ApiRepo): DiffRepoView => ({
  taskRepoId: repo.taskRepoId,
  name: repo.repo,
  branch: repo.branch,
  base: repo.base,
  ahead: repo.aheadBy ?? 0,
  behind: repo.behindBy ?? 0,
  headSha: repo.headSha,
  state:
    repo.state === "no-head"
      ? { kind: "not-pushed" }
      : repo.state === "loading"
        ? { kind: "loading" }
        : {
            kind: "ready",
            files: repo.files.map((file) => fileViewOf(file, repo.hostUrl)),
            filesTruncated: repo.filesTruncated ? { shown: repo.files.length, url: repo.hostUrl ?? "" } : null,
          },
});

/** A tRPC error's code, read without trusting its shape. */
const errorCode = (cause: unknown): unknown => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const data: unknown = Reflect.get(cause, "data");
  return typeof data === "object" && data !== null ? Reflect.get(data, "code") : undefined;
};

const signOf =(kind: "context" | "add" | "del"): "+" | "-" | " " => (kind === "add" ? "+" : kind === "del" ? "-" : " ");

export const commentViewOf = (comment: ApiComment): DiffCommentView => ({
  id: comment.commentId,
  taskRepoId: comment.taskRepoId,
  path: comment.path,
  side: comment.side,
  line: comment.line,
  headSha: comment.headSha,
  body: comment.body,
  state: comment.state,
  author: comment.author.name,
  at: comment.updatedAt ?? comment.createdAt ?? 0,
  outdated: comment.outdated ? { sign: comment.quoted === null ? " " : signOf(comment.quoted.kind), text: comment.quoted?.text ?? "" } : null,
});

export const ChangesTab = ({
  taskId,
  agent,
  driver,
  isDriver,
  running,
  steersMidTurn,
  sessionGoing,
  onTakeOver,
  onSeeActivity,
}: {
  readonly taskId: TaskId;
  readonly agent: string;
  readonly driver: string | null;
  readonly isDriver: boolean;
  readonly running: boolean;
  readonly steersMidTurn: boolean;
  readonly sessionGoing: boolean;
  readonly onTakeOver: () => void;
  readonly onSeeActivity: () => void;
}) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const diff = useQuery({ ...trpc.diff.get.queryOptions({ taskId }), refetchInterval: (query) => (query.state.data?.repos.some((repo) => repo.state === "loading") === true ? 3000 : 30_000) });
  const comments = useQuery(trpc.diff.comments.list.queryOptions({ taskId }));
  const refreshComments = () => queryClient.invalidateQueries({ queryKey: trpc.diff.comments.list.queryKey({ taskId }) });
  const save = useMutation(trpc.diff.comments.save.mutationOptions({ onSettled: refreshComments }));
  const remove = useMutation(trpc.diff.comments.delete.mutationOptions({ onSettled: refreshComments }));
  const send = useMutation(trpc.diff.comments.send.mutationOptions({ onSettled: refreshComments }));
  const remember = useMutation(trpc.memory.rememberThis.mutationOptions());
  const update = useMutation(trpc.tasks.updateBranch.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: trpc.tasks.get.queryKey({ taskId }) }) }));
  const [reviewState, setReviewState] = useState<PressState>({ kind: "idle" });

  const press = (mutation: { readonly isPending: boolean; readonly isSuccess: boolean; readonly error: Parameters<typeof errorText>[0] }, n: number): PressState =>
    mutation.isPending ? { kind: "sending" } : mutation.error !== null ? { kind: "refused", message: errorText(mutation.error) ?? t("errors.unknown") } : mutation.isSuccess ? { kind: "sent", n } : { kind: "idle" };

  const delivery: SendDelivery = !isDriver && sessionGoing ? { kind: "not-driver", driver: driver ?? t("taskPage.someone") } : !sessionGoing ? { kind: "reopen" } : running ? (steersMidTurn ? { kind: "steer" } : { kind: "after-turn" }) : { kind: "idle" };

  const onSave = async (target: CommentTarget, body: string, editing: DiffCommentView | null): Promise<SaveResult> => {
    const repo = diff.data?.repos.find((candidate) => candidate.taskRepoId === target.taskRepoId);
    const head = repo?.headSha ?? null;
    try {
      if (editing !== null) await save.mutateAsync({ taskId, commentId: diffCommentIdSchema.parse(editing.id), body });
      else if (head === null) return { kind: "refused", message: t("errors.unknown") };
      else await save.mutateAsync({ taskId, taskRepoId: taskRepoIdSchema.parse(target.taskRepoId), path: target.path, side: target.side, line: target.line, headSha: gitShaSchema.parse(head), body });
      return { kind: "saved" };
    } catch (cause) {
      if (errorCode(cause) === "CONFLICT") return { kind: "line-gone" };
      return { kind: "refused", message: cause instanceof Error ? cause.message : t("errors.unknown") };
    }
  };

  const load =
    diff.data !== undefined
      ? { kind: "ready" as const, repos: diff.data.repos.map(repoViewOf), lastPushAt: diff.data.asOf }
      : diff.error !== null
        ? { kind: "failed" as const, error: errorText(diff.error) ?? t("errors.unknown"), retry: () => void diff.refetch() }
        : { kind: "loading" as const };

  return (
    <ChangesBody
      load={load}
      comments={(comments.data?.comments ?? []).map(commentViewOf)}
      canComment
      update={{
        state: press(update, 1),
        driver: isDriver || !sessionGoing ? null : (driver ?? t("taskPage.someone")),
        agent,
        onUpdate: () => { update.mutate({ taskId }); },
        onTakeOver,
      }}
      review={{
        delivery,
        agent,
        state: reviewState.kind === "idle" ? press(send, comments.data?.draftCount ?? 0) : reviewState,
        onSend: (drafts) => {
          setReviewState({ kind: "idle" });
          send.mutate({ taskId }, { onSuccess: () => { setReviewState({ kind: "sent", n: drafts.length }); setTimeout(() => { setReviewState({ kind: "idle" }); send.reset(); }, 6000); } });
        },
        onTakeOver,
        onSeeActivity,
      }}
      onSave={onSave}
      onRemember={async (comment) => {
        try {
          await remember.mutateAsync({ source: { diffCommentId: diffCommentIdSchema.parse(comment.id) } });
          return { kind: "proposed" };
        } catch (cause) {
          return { kind: "refused", message: cause instanceof Error ? cause.message : t("errors.unknown") };
        }
      }}
      onDelete={(comment) => { remove.mutate({ taskId, commentId: diffCommentIdSchema.parse(comment.id) }); }}
      onUndoDelete={(comment) => {
        void onSave({ taskRepoId: comment.taskRepoId, path: comment.path, side: comment.side, line: comment.line }, comment.body, null);
      }}
    />
  );
};
