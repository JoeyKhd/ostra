import type { Db } from "@ostra/db";
import { diffCommentsForMember, diffLineAt, parseUnifiedDiff, saveDiffComment, sendDiffCommentsWith, storedDiffInTx, taskDiffs } from "@ostra/domain";
import type { StoredDiff } from "@ostra/domain";
import { TRPCError } from "@trpc/server";
import { diffCommentIdSchema, gitShaSchema, memberIdSchema, repoIdSchema, runnerLimits, taskIdSchema, taskRepoIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { router, taskProcedure, unwrap } from "../trpc/init.ts";

// F-027, F-072 (ticket 38; ADR 0051): the Changes tab's data. `diff.get` is each changed repo's
// branch against its base as of the last push: the files with their parsed hunks, or "loading"
// while `diff.fetch` runs (the task's change notice then tells the page). `diff.comments.*` are a
// member's drafts and every sent comment. Any member who can open the project reads the diff and
// writes drafts; sending follows the composer's rule (the driver, or a reopen). A patch and a
// comment hold the repo's code and a member's words: they are returned to members of the project
// and never logged.

const taskInput = z.strictObject({ taskId: taskIdSchema });

/** How a file is drawn: its hunks, or one of the notes that stand in for them. */
type FileKind = "text" | "too-large" | "binary" | "renamed-unchanged";

const fileKindOf = (file: StoredDiff["files"][number]): FileKind => {
  if (file.tooLarge) {
    return "too-large";
  }
  if (file.patch !== null && file.patch !== "") {
    return "text";
  }
  // No patch and nothing changed in a renamed or copied file; no patch at all is a binary file.
  return (file.status === "renamed" || file.status === "copied") && file.additions === 0 && file.deletions === 0 ? "renamed-unchanged" : "binary";
};

/** A stored diff's files as the Changes tab and the review screen draw them (F-027, F-102). */
export const diffFileViews = (diff: StoredDiff | null) =>
  (diff?.files ?? []).map((file) => {
    const kind = fileKindOf(file);
    return {
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      kind,
      /** The parsed patch; empty for a file the diff does not draw. */
      ...(kind === "text" ? parseUnifiedDiff(file.patch) : { hunks: [], oldNoNewlineAtEnd: false, newNoNewlineAtEnd: false }),
    };
  });

const commentsRouter = router({
  /**
   * The member's own drafts and every sent comment on the task, oldest first, with who wrote each,
   * when, and, for a comment that a later head made outdated, the line as it was.
   */
  list: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const { db } = ctx.deps;
    const views = (await diffCommentsForMember(db, ctx.scope, { taskId: input.taskId })) ?? [];
    const ids = views.map((view) => view.commentId);
    const [rows, repos] = await Promise.all([
      ids.length === 0 ? [] : db.diffComment.findMany({ where: { id: { in: ids } }, select: { id: true, createdAt: true, updatedAt: true } }),
      db.taskRepo.findMany({ where: { taskId: input.taskId, organizationId: ctx.scope.organizationId }, select: { id: true, repoId: true, repo: { select: { fullName: true } } } }),
    ]);
    const authorIds = [...new Set(views.map((view) => view.memberId))];
    const authors = authorIds.length === 0 ? [] : await db.member.findMany({ where: { id: { in: authorIds }, organizationId: ctx.scope.organizationId }, select: { id: true, user: { select: { name: true } } } });
    const times = new Map(rows.map((row) => [row.id, row]));
    const diffs = new Map<string, StoredDiff | null>();
    const lineOf = async (view: (typeof views)[number]) => {
      const repo = repos.find((candidate) => candidate.id === view.taskRepoId);
      if (repo === undefined) {
        return null;
      }
      const key = `${repo.repoId}:${view.headSha}`;
      if (!diffs.has(key)) {
        diffs.set(key, await storedDiffInTx(db, repoIdSchema.parse(repo.repoId), view.headSha));
      }
      const diff = diffs.get(key) ?? null;
      const line = diff === null ? null : diffLineAt(diff, view.path, view.side, view.line);
      return line === null ? null : { kind: line.kind, text: line.text };
    };
    const comments = [];
    for (const view of views) {
      const repo = repos.find((candidate) => candidate.id === view.taskRepoId);
      const time = times.get(view.commentId);
      comments.push({
        commentId: view.commentId,
        taskRepoId: view.taskRepoId,
        repo: repo?.repo.fullName ?? "",
        path: view.path,
        side: view.side,
        line: view.line,
        /** The head the comment was written on: its first seven characters read `line {n} · {sha}`. */
        headSha: view.headSha,
        body: view.body,
        state: view.state,
        outdated: view.outdated,
        /** The line as it was when the comment was written: for an outdated comment's quote. */
        quoted: view.outdated ? await lineOf(view) : null,
        sentInSeq: view.sentInSeq,
        mine: view.memberId === ctx.scope.memberId,
        author: { memberId: memberIdSchema.parse(view.memberId), name: authors.find((author) => author.id === view.memberId)?.user.name ?? "" },
        createdAt: time?.createdAt.getTime() ?? null,
        updatedAt: time?.updatedAt.getTime() ?? null,
      });
    }
    return { comments, draftCount: comments.filter((comment) => comment.state === "draft").length, maxPerSend: runnerLimits.diffCommentsPerSendMax, maxChars: runnerLimits.diffCommentMaxChars };
  }),

  /**
   * Saves a draft: a new one on a line of a head's diff, or an edit of the member's own. The line
   * must exist in that head's diff, or the save is refused.
   */
  save: taskProcedure(
    "read",
    z.union([
      z.strictObject({ taskId: taskIdSchema, taskRepoId: taskRepoIdSchema, path: z.string().min(1).max(4096), side: z.enum(["old", "new"]), line: z.number().int().positive(), headSha: gitShaSchema, body: z.string().max(runnerLimits.diffCommentMaxChars * 2) }),
      z.strictObject({ taskId: taskIdSchema, commentId: diffCommentIdSchema, body: z.string().max(runnerLimits.diffCommentMaxChars * 2) }),
    ]),
  ).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    if ("commentId" in input) {
      await assertCommentOfTask(ctx.deps.db, ctx.scope.organizationId, input.taskId, input.commentId);
    } else {
      const repo = await db.taskRepo.findFirst({ where: { id: input.taskRepoId, taskId: input.taskId, organizationId: ctx.scope.organizationId }, select: { id: true } });
      if (repo === null) {
        throw notFound("repo of the task");
      }
    }
    const result = await saveDiffComment(
      { db, ...ports },
      ctx.scope,
      "commentId" in input
        ? { action: "edit", commentId: input.commentId, body: input.body }
        : { action: "create", taskRepoId: input.taskRepoId, path: input.path, side: input.side, line: input.line, headSha: input.headSha, body: input.body },
    );
    const saved = unwrap(result, { "not-found": "NOT_FOUND", "not-yours": "FORBIDDEN", "no-such-line": "CONFLICT", "too-long": "BAD_REQUEST", sent: "CONFLICT" });
    return { commentId: saved.commentId };
  }),

  /** Deletes the member's own draft. A sent comment, and another member's draft, stay. */
  delete: taskProcedure("read", z.strictObject({ taskId: taskIdSchema, commentId: diffCommentIdSchema })).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    await assertCommentOfTask(db, ctx.scope.organizationId, input.taskId, input.commentId);
    const result = await saveDiffComment({ db, ...ports }, ctx.scope, { action: "delete", commentId: input.commentId });
    const deleted = unwrap(result, { "not-found": "NOT_FOUND", "not-yours": "FORBIDDEN", "no-such-line": "CONFLICT", "too-long": "BAD_REQUEST", sent: "CONFLICT" });
    return { commentId: deleted.commentId };
  }),

  /**
   * "Send N comments to the agent": the member's drafts as one member message, sent as the
   * composer sends. The driver sends to a session that is going; with none going it reopens the
   * task. Anyone else is told "Take over to send". Returns the message's sequence.
   */
  send: taskProcedure("read", taskInput).mutation(async ({ ctx, input }) => {
    const { db, ports, settings } = ctx.deps;
    const result = await sendDiffCommentsWith({ db, ...ports }, { spendCap: { capMicroUsd: settings.taskSpendCapMicroUsd, capTokens: settings.taskTokenCap } }, ctx.scope, { taskId: input.taskId });
    const sent = unwrap(result, {
      "not-found": "NOT_FOUND",
      "no-drafts": "PRECONDITION_FAILED",
      "take-over-to-send": "FORBIDDEN",
      "too-many": "BAD_REQUEST",
      forbidden: "FORBIDDEN",
      merged_reopen_later: "PRECONDITION_FAILED",
      "ticket-has-task": "CONFLICT",
      "not-reopenable": "CONFLICT",
      "text-required": "BAD_REQUEST",
      "spend-cap-reached": "PRECONDITION_FAILED",
      "profile-not-allowed": "FORBIDDEN",
    });
    return { sent: sent.sent, delivery: sent.delivery, seq: sent.seq };
  }),
});

export const diffRouter = router({
  /**
   * Each changed repo's branch against its base (F-027). A repo whose head isn't fetched yet answers
   * `loading` and queues one `diff.fetch`; the task's change notice tells the page when it is in.
   */
  get: taskProcedure("read", taskInput).query(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    const diffs = await taskDiffs({ db, jobs: ports.jobs }, ctx.scope, { taskId: input.taskId });
    const found = unwrap(diffs, { "not-found": "NOT_FOUND" });
    const [rows, saved] = await Promise.all([
      db.taskRepo.findMany({
        where: { taskId: input.taskId, organizationId },
        orderBy: { createdAt: "asc" },
        select: { id: true, branchName: true, baseBranch: true, headSha: true, behindBy: true, behindCheckedAt: true, prUrl: true, repo: { select: { id: true, fullName: true } } },
      }),
      db.event.findFirst({ where: { taskId: input.taskId, organizationId, kind: "session.saved" }, orderBy: { seq: "desc" }, select: { occurredAt: true } }),
    ]);
    const repos = found.repos.flatMap((entry) => {
      const row = rows.find((candidate) => candidate.id === entry.taskRepoId);
      if (row === undefined) {
        return [];
      }
      const diff = entry.state === "ready" ? entry.diff : null;
      return [
        {
          taskRepoId: entry.taskRepoId,
          repoId: repoIdSchema.parse(row.repo.id),
          repo: row.repo.fullName,
          branch: row.branchName,
          base: row.baseBranch,
          headSha: row.headSha,
          prUrl: row.prUrl,
          /** `ready`, `loading` (the head's diff is being fetched) or `no-head` (nothing pushed yet). */
          state: entry.state,
          aheadBy: diff?.aheadBy ?? null,
          /** The webhook's figure when there is one, else the compare's. */
          behindBy: row.behindBy ?? diff?.behindBy ?? null,
          mergeBase: diff?.mergeBase ?? null,
          /** The host sent fewer files than changed, or the install's file limit cut the list. */
          filesTruncated: diff?.filesTruncated ?? false,
          /** The page on the code host that shows the whole diff. */
          hostUrl: diff?.hostUrl ?? null,
          files: diffFileViews(diff),
        },
      ];
    });
    return {
      taskId: input.taskId,
      repos,
      /** When the last push landed ("As of the last turn"), or `null` before the first. */
      asOf: saved?.occurredAt.getTime() ?? null,
    };
  }),

  comments: commentsRouter,
});

const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `No such ${what}` });

/** A comment of this task, in this organization: a comment of another task is not this task's to touch. */
const assertCommentOfTask = async (db: Db, organizationId: string, taskId: string, commentId: string): Promise<void> => {
  const comment = await db.diffComment.findFirst({ where: { id: commentId, taskId, organizationId }, select: { id: true } });
  if (comment === null) {
    throw notFound("comment");
  }
};
