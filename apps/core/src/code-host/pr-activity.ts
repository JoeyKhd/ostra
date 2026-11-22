import type { CodeHostAdapter, Logger, PullRequestComment, PullRequestReview, RepoAccess, ReviewComment } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { JobQueue } from "@ostra/domain";
import type { ConnectionId, OrganizationId, RepoFullName, TaskRepoId } from "@ostra/protocol";
import { z } from "zod";

import { changesRequestedHint } from "../review-loop/changes-requested.ts";
import type { ReconciledCommentContext } from "./pr-comments.ts";
import type { PrCommentEvent } from "./pull-requests.ts";

// What a missed webhook would have brought on an open task PR (F-044, ADR 0011's guarantee 2;
// Q344, settled by the maintainer on 2026-11-22: "Add them to reconcile"). Each pass of
// `github.reconcile-prs` reads, per open task PR, from a cursor kept on its task repo:
// - its conversation comments changed since the cursor (`listPullRequestComments`, one call);
// - its reviews (`listReviews`, one call), each submitted since the cursor, and for a person's
//   review its line comments (`listReviewComments`, one call per new review).
// Each is handed on as its webhook's event would be: a comment to the same filters and acceptance
// as `issue_comment` and `pull_request_review_comment`, a review to the same "changes requested"
// hint as `pull_request_review`. They land once whichever way they came: the domain keys the member
// message by the host's comment or review ID (`pr-comment:<kind>:<id>`, `changes-requested:<id>`),
// and the reaction is one per comment on the host.
//
// The cursor holds, per stream, the host's time it has read up to and the keys it handled near it.
// The host is asked from that time less `ACTIVITY_OVERLAP_MS`, so a change at the same second, or
// one the host lists a moment late, is still read, and the keys skip what was handled already. A
// comment's key is its ID and update time, so an edit is read again. Something that waits (a task
// still starting) holds the cursor before it, and the next pass tries it again.
//
// Only a webhook names who edited a comment, so a comment the reconcile finds edited after it was
// posted is never heard: a collaborator's edit of a member's comment is never the member's (F-053,
// F-119). The author's own edit then needs its webhook.
//
// Logs carry IDs, counts and reasons, never a comment's or a review's text.

/** How far before the cursor's time the host is asked from: a change listed late, or at the same second. */
export const ACTIVITY_OVERLAP_MS = 120_000;
/**
 * A line comment changed later than this after its review was submitted was edited: a pending
 * review's comments may be stamped as it's submitted. A conversation comment changed at all after
 * it was posted was edited (the host's times are to the second, and equal on a comment never edited).
 */
const EDIT_SLACK_MS = 1_000;
/** The most keys a stream's cursor keeps; past it the oldest go, and are at most read again. */
const SEEN_MAX = 500;
/** The most new reviews one pass reads the line comments of, per PR; the next pass carries on. */
export const MAX_REVIEWS_PER_PASS = 10;

const seenSchema = z.strictObject({ key: z.string().min(1).max(200), at: z.number().int().nonnegative() });
const streamSchema = z.strictObject({ at: z.number().int().nonnegative().nullable(), seen: z.array(seenSchema).max(SEEN_MAX) });

/** The cursor on a task repo (`prActivityCursor`): ostra's own format, so unknown fields are refused. */
export const prActivityCursorSchema = z.strictObject({ prNumber: z.number().int().positive(), comments: streamSchema, reviews: streamSchema });
export type PrActivityCursor = z.infer<typeof prActivityCursorSchema>;
export type StreamCursor = z.infer<typeof streamSchema>;

/** Something the host listed, by the key the cursor knows it by and its time on the host. */
export type ActivityItem = { readonly key: string; readonly at: number };

const EMPTY: StreamCursor = { at: null, seen: [] };

/** The stored cursor for the PR, or an empty one: none yet, another PR's, or one that doesn't read. */
export const cursorOf = (stored: unknown, prNumber: number): PrActivityCursor => {
  const parsed = prActivityCursorSchema.safeParse(stored);
  return parsed.success && parsed.data.prNumber === prNumber ? parsed.data : { prNumber, comments: EMPTY, reviews: EMPTY };
};

/** The host's time to read a stream from: the cursor's less the overlap, or `null` for everything. */
export const sinceOf = (cursor: StreamCursor): number | null => (cursor.at === null ? null : Math.max(0, cursor.at - ACTIVITY_OVERLAP_MS));

/** What the host listed that the cursor hasn't handled, oldest first. */
export const freshOf = <T extends ActivityItem>(cursor: StreamCursor, listed: readonly T[]): T[] => {
  const since = sinceOf(cursor);
  const seen = new Set(cursor.seen.map((one) => one.key));
  return listed.filter((item) => (since === null || item.at >= since) && !seen.has(item.key)).sort((a, b) => a.at - b.at);
};

/**
 * The cursor past a pass: its time moves to the newest change listed, or, when something waits, to
 * just before the first that waits, so the next pass lists it again; it keeps the keys handled that
 * the next pass may list again.
 */
export const advance = (cursor: StreamCursor, listed: readonly ActivityItem[], handled: readonly ActivityItem[], waiting: readonly ActivityItem[]): StreamCursor => {
  const newest = listed.reduce<number | null>((max, item) => (max === null || item.at > max ? item.at : max), cursor.at);
  const firstWaiting = waiting.reduce<number | null>((min, item) => (min === null || item.at < min ? item.at : min), null);
  const at = firstWaiting === null ? newest : Math.max(0, firstWaiting - 1);
  const floor = at === null ? null : at - ACTIVITY_OVERLAP_MS;
  const byKey = new Map<string, number>();
  for (const one of [...cursor.seen, ...handled]) {
    byKey.set(one.key, one.at);
  }
  const seen = [...byKey.entries()]
    .map(([key, when]) => ({ key, at: when }))
    .filter((one) => floor === null || one.at >= floor)
    .sort((a, b) => a.at - b.at)
    .slice(-SEEN_MAX);
  return { at, seen };
};

export type PrActivityDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly codeHost: CodeHostAdapter;
  readonly logger: Logger;
  /** What a comment found does: `reconciledCommentHook`. Without it, comments are read past and nothing is heard. */
  readonly onComment?: (context: ReconciledCommentContext, event: PrCommentEvent) => Promise<"handled" | "waits">;
};

export type PrActivityInput = {
  readonly organizationId: OrganizationId;
  readonly connectionId: ConnectionId;
  readonly taskRepoId: TaskRepoId;
  readonly access: RepoAccess;
  readonly repo: RepoFullName;
  readonly hostRepoId: string;
  readonly prNumber: number;
  readonly headSha: string;
  /** The PR's page: a line comment's link when the host gives none. */
  readonly prUrl: string | null;
  /** The task repo's `prActivityCursor`, as stored. */
  readonly cursor: unknown;
};

export type PrActivityOutcome = {
  /** Comments and reviews read for the first time this pass. */
  readonly comments: number;
  readonly reviews: number;
  /** Something waits for the task's session, or a read failed: the next pass tries it again. */
  readonly waiting: number;
  readonly stoppedEarly: "rate-limited" | null;
};

/** A conversation comment the host listed, as its `issue_comment` webhook would carry it. */
const commentEvent = (input: PrActivityInput, comment: PullRequestComment): PrCommentEvent => ({
  kind: "issue_comment",
  // Only an unedited comment is handed on, and it's its author's: the webhook's `created`.
  action: "created",
  installationId: null,
  hostRepoId: input.hostRepoId,
  repo: input.repo,
  number: input.prNumber,
  onPullRequest: true,
  comment,
  senderId: comment.authorId,
});

/** A review's line comment, as its `pull_request_review_comment` webhook would carry it; `null` when it was edited after the review, or can't be told. */
const lineCommentEvent = (input: PrActivityInput, review: PullRequestReview, comment: ReviewComment): PrCommentEvent | null => {
  const posted = Math.max(comment.createdAt ?? 0, review.submittedAt ?? 0);
  if (comment.updatedAt === undefined || comment.updatedAt > posted + EDIT_SLACK_MS) {
    return null;
  }
  const url = comment.url ?? review.url ?? input.prUrl;
  if (url === null || comment.userId === "") {
    return null;
  }
  return {
    kind: "pull_request_review_comment",
    action: "created",
    installationId: null,
    hostRepoId: input.hostRepoId,
    repo: input.repo,
    number: input.prNumber,
    comment: { commentId: comment.id, authorId: comment.userId, authorLogin: comment.login ?? review.login, body: comment.body, url },
    senderId: comment.userId,
    path: comment.path,
    side: comment.side,
    line: comment.line,
  };
};

/**
 * One open task PR's comments and reviews since its cursor, each handed on as its webhook would
 * be, and the cursor moved past what was handled. Needs the host's `reconcileReads`; a host
 * without it reads nothing here, and those arrive only by webhook.
 */
export const reconcilePrActivity = async (deps: PrActivityDeps, input: PrActivityInput): Promise<PrActivityOutcome> => {
  const { codeHost } = deps;
  const none: PrActivityOutcome = { comments: 0, reviews: 0, waiting: 0, stoppedEarly: null };
  if (!codeHost.capabilities.reconcileReads) {
    return none;
  }
  const context: ReconciledCommentContext = { organizationId: input.organizationId, connectionId: input.connectionId, logger: deps.logger };
  const before = cursorOf(input.cursor, input.prNumber);
  let cursor: PrActivityCursor = before;
  let comments = 0;
  let reviews = 0;
  let waiting = 0;
  let stoppedEarly: "rate-limited" | null = null;
  /** A comment found: heard as its webhook's, or read past when there's no hook. */
  const hand = async (event: PrCommentEvent): Promise<"handled" | "waits"> => {
    if (deps.onComment === undefined) return "handled";
    try {
      return await deps.onComment(context, event);
    } catch (error) {
      deps.logger.warn("pr.activity-comment-failed", { taskRepoId: input.taskRepoId, commentId: event.comment.commentId, error: error instanceof Error ? error.name : "unknown" });
      return "waits";
    }
  };

  // ---- the conversation's comments, since the cursor ----
  const listed = await codeHost.listPullRequestComments(input.access, input.prNumber, sinceOf(cursor.comments));
  if (!listed.ok) {
    if (listed.error.code === "rate-limited") {
      return { ...none, stoppedEarly: "rate-limited" };
    }
    deps.logger.warn("pr.activity-read-failed", { taskRepoId: input.taskRepoId, prNumber: input.prNumber, read: "comments", code: listed.error.code });
    waiting += 1;
  } else {
    const items = listed.value.map((comment) => ({ comment, key: `${comment.commentId}@${String(comment.updatedAt)}`, at: comment.updatedAt }));
    const handled: ActivityItem[] = [];
    const waits: ActivityItem[] = [];
    for (const item of freshOf(cursor.comments, items)) {
      comments += 1;
      if (item.comment.updatedAt > item.comment.createdAt) {
        // Edited after it was posted: only its webhook names who edited it.
        deps.logger.info("pr.activity-comment-edited", { taskRepoId: input.taskRepoId, commentId: item.comment.commentId });
        handled.push(item);
        continue;
      }
      const { commentId, authorId, authorLogin, body, url } = item.comment;
      if ((await hand(commentEvent(input, { commentId, authorId, authorLogin, body, url }))) === "waits") {
        waits.push(item);
      } else {
        handled.push(item);
      }
    }
    waiting += waits.length;
    cursor = { ...cursor, comments: advance(cursor.comments, items, handled, waits) };
  }

  // ---- the reviews submitted since the cursor, and a person's line comments ----
  const listedReviews = codeHost.capabilities.reviews ? await codeHost.listReviews(input.access, input.prNumber) : null;
  if (listedReviews !== null && !listedReviews.ok) {
    if (listedReviews.error.code === "rate-limited") {
      stoppedEarly = "rate-limited";
    } else {
      deps.logger.warn("pr.activity-read-failed", { taskRepoId: input.taskRepoId, prNumber: input.prNumber, read: "reviews", code: listedReviews.error.code });
      waiting += 1;
    }
  } else if (listedReviews !== null) {
    const items = listedReviews.value.flatMap((review) => (review.submittedAt === null || review.state === "pending" ? [] : [{ review, key: review.reviewId, at: review.submittedAt }]));
    const fresh = freshOf(cursor.reviews, items);
    const handled: ActivityItem[] = [];
    const waits: ActivityItem[] = fresh.slice(MAX_REVIEWS_PER_PASS);
    for (const item of fresh.slice(0, MAX_REVIEWS_PER_PASS)) {
      if (stoppedEarly !== null) {
        waits.push(item);
        continue;
      }
      reviews += 1;
      const { review } = item;
      // A linked member's "changes requested" reopens the task, as the review's webhook does (F-105).
      const event = { kind: "pull_request_review", action: "submitted", installationId: null, hostRepoId: input.hostRepoId, repo: input.repo, number: input.prNumber, headSha: input.headSha, review } as const;
      try {
        await changesRequestedHint({ db: deps.db, jobs: deps.jobs, capable: codeHost.capabilities.reviews }, context, event);
      } catch (error) {
        deps.logger.warn("pr.activity-review-failed", { taskRepoId: input.taskRepoId, reviewId: review.reviewId, error: error instanceof Error ? error.name : "unknown" });
        waits.push(item);
        continue;
      }
      // A person's line comments, each as its webhook's; a bot's (ostra's own review's among them) are nobody's ask.
      if (review.isBot || !codeHost.capabilities.reviewComments || deps.onComment === undefined) {
        handled.push(item);
        continue;
      }
      const lines = await codeHost.listReviewComments(input.access, input.prNumber, review.reviewId);
      if (!lines.ok) {
        if (lines.error.code === "rate-limited") stoppedEarly = "rate-limited";
        else deps.logger.warn("pr.activity-read-failed", { taskRepoId: input.taskRepoId, prNumber: input.prNumber, read: "review-comments", code: lines.error.code });
        waits.push(item);
        continue;
      }
      let held = false;
      for (const comment of lines.value) {
        const lineEvent = lineCommentEvent(input, review, comment);
        if (lineEvent === null) {
          deps.logger.info("pr.activity-comment-edited", { taskRepoId: input.taskRepoId, commentId: comment.id });
          continue;
        }
        if ((await hand(lineEvent)) === "waits") held = true;
      }
      if (held) {
        waits.push(item);
      } else {
        handled.push(item);
      }
    }
    waiting += waits.length;
    cursor = { ...cursor, reviews: advance(cursor.reviews, items, handled, waits) };
  }

  if (JSON.stringify(cursor) !== JSON.stringify(before)) {
    // Only while the task repo still has this PR: a newer one starts its own cursor.
    await deps.db.taskRepo.updateMany({ where: { id: input.taskRepoId, organizationId: input.organizationId, prNumber: input.prNumber }, data: { prActivityCursor: cursor } });
  }
  if (comments + reviews + waiting > 0) {
    deps.logger.info("pr.activity", { taskRepoId: input.taskRepoId, prNumber: input.prNumber, comments, reviews, waiting });
  }
  return { comments, reviews, waiting, stoppedEarly };
};
