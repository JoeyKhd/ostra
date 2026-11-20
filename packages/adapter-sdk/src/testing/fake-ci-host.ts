import type { RepoFullName } from "@ostra/protocol";

import { lineInRanges } from "../code-host/base.ts";
import type {
  CiCheckRun,
  CiCheckRunStatus,
  CiConclusion,
  CiStatus,
  CommentReviewInput,
  DiffFileLines,
  RequestedReviewers,
  ReviewComment,
} from "../code-host/base.ts";

// Milestone 6 (ticket 03, ADR 0058): the CI, reviews and reviewers of a fake code host, in memory,
// as GitHub keeps them. The tiny code host serves the milestone 6 operations from it when it's
// given one, and core's fakes can keep their state here too. What it models, from GitHub's docs:
// - check runs from any app on a head, each with a log (an Actions job's, or another app's
//   summary and text), which can expire; a run that stays `queued`; commit statuses by context,
//   one of which may never complete;
// - a comment-type review with line comments, refused whole when a comment's line isn't in the
//   diff (GitHub's 422, "Pull request review thread line must be part of the diff");
// - requested reviewers and teams, `CODEOWNERS` in the three places GitHub looks, in its order;
// - a review's line comments.

/** A check run the fake holds, with its log: its text, `"expired"`, or `null` for none. */
export type FakeCiCheckRun = CiCheckRun & { readonly repo: RepoFullName; readonly headSha: string; readonly log: FakeCiLog };

/** A run's log as the fake keeps it. */
export type FakeCiLog = { readonly text: string } | "expired" | null;

export type FakeCheckRunInput = {
  readonly headSha: string;
  readonly name: string;
  readonly appSlug: string | null;
  readonly status: CiCheckRunStatus;
  readonly conclusion: CiConclusion | null;
  readonly detailsUrl?: string | null;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly log?: FakeCiLog;
};

/** A review the fake holds: the comment-type reviews the App posted, with their line comments. */
export type FakeCiReview = {
  readonly reviewId: string;
  readonly repo: RepoFullName;
  readonly number: number;
  readonly commitId: string;
  readonly body: string;
  readonly userId: string;
  readonly comments: readonly ReviewComment[];
};

/** Where GitHub looks for `CODEOWNERS`, in its order. */
export const codeOwnersPaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** A review the fake refused: why, and which comment, as GitHub's 422 would say. */
export type FakeReviewRefusal = { readonly kind: "event"; readonly event: string } | { readonly kind: "line-outside-diff"; readonly commentIndex: number };

const prKey = (repo: RepoFullName, number: number): string => `${repo}#${String(number)}`;
const headKey = (repo: RepoFullName, headSha: string): string => `${repo}@${headSha}`;

export class FakeCiHost {
  readonly #runs: FakeCiCheckRun[] = [];
  readonly #statuses = new Map<string, CiStatus[]>();
  readonly #diffs = new Map<string, readonly DiffFileLines[]>();
  readonly #reviews: FakeCiReview[] = [];
  readonly #requested = new Map<string, RequestedReviewers>();
  readonly #files = new Map<string, string>();
  #nextRun = 0;
  #nextReview = 0;
  #nextComment = 0;

  /** Another app's check run on a head (or ostra's own, by its slug). */
  addCheckRun(repo: RepoFullName, input: FakeCheckRunInput): FakeCiCheckRun {
    this.#nextRun += 1;
    const run: FakeCiCheckRun = {
      id: String(70_000 + this.#nextRun),
      repo,
      headSha: input.headSha,
      name: input.name,
      appSlug: input.appSlug,
      status: input.status,
      conclusion: input.conclusion,
      detailsUrl: input.detailsUrl ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      log: input.log ?? null,
    };
    this.#runs.push(run);
    return run;
  }

  /** A head's check runs, in the order they were made. */
  checkRuns(repo: RepoFullName, headSha: string): readonly FakeCiCheckRun[] {
    return this.#runs.filter((run) => run.repo === repo && run.headSha === headSha);
  }

  checkRun(repo: RepoFullName, id: string): FakeCiCheckRun | undefined {
    return this.#runs.find((run) => run.repo === repo && run.id === id);
  }

  /** Sets a commit status by its context, replacing the one the context had, as GitHub's latest-wins does. */
  setStatus(repo: RepoFullName, headSha: string, status: CiStatus): void {
    const key = headKey(repo, headSha);
    const list = (this.#statuses.get(key) ?? []).filter((one) => one.context !== status.context);
    this.#statuses.set(key, [...list, status]);
  }

  statuses(repo: RepoFullName, headSha: string): readonly CiStatus[] {
    return [...(this.#statuses.get(headKey(repo, headSha)) ?? [])];
  }

  /** The lines a PR's diff covers, per file and side, as its hunks say. */
  setDiff(repo: RepoFullName, number: number, files: readonly DiffFileLines[]): void {
    this.#diffs.set(prKey(repo, number), files);
  }

  diff(repo: RepoFullName, number: number): readonly DiffFileLines[] | undefined {
    return this.#diffs.get(prKey(repo, number));
  }

  /**
   * Posts a comment-type review as `userId`, or refuses it as GitHub would: any event but
   * `COMMENT` (ostra's rule, ADR 0028), or a line comment off the diff (GitHub's 422). A refused
   * review posts nothing.
   */
  createReview(repo: RepoFullName, number: number, input: CommentReviewInput, userId: string): FakeCiReview | FakeReviewRefusal {
    // Read as a string: a caller that got past the type, as a test under `@ts-expect-error` does, is refused here too.
    const event: string = input.event;
    if (event !== "COMMENT") {
      return { kind: "event", event };
    }
    const diff = this.diff(repo, number) ?? [];
    const outside = input.comments.findIndex((comment) => {
      const file = diff.find((one) => one.path === comment.path);
      return file === undefined || !lineInRanges(comment.side === "new" ? file.new : file.old, comment.line);
    });
    if (outside >= 0) {
      return { kind: "line-outside-diff", commentIndex: outside };
    }
    this.#nextReview += 1;
    const review: FakeCiReview = {
      reviewId: String(80_000 + this.#nextReview),
      repo,
      number,
      commitId: input.commitId,
      body: input.body,
      userId,
      comments: input.comments.map((comment) => {
        this.#nextComment += 1;
        return { id: String(90_000 + this.#nextComment), path: comment.path, line: comment.line, side: comment.side, body: comment.body, userId };
      }),
    };
    this.#reviews.push(review);
    return review;
  }

  /** A person's review with line comments, as they post it on the host (F-105's "changes requested"). */
  addPersonReview(repo: RepoFullName, number: number, input: { readonly reviewId: string; readonly commitId: string; readonly userId: string; readonly comments: readonly Omit<ReviewComment, "id" | "userId">[] }): FakeCiReview {
    const review: FakeCiReview = {
      reviewId: input.reviewId,
      repo,
      number,
      commitId: input.commitId,
      body: "",
      userId: input.userId,
      comments: input.comments.map((comment) => {
        this.#nextComment += 1;
        return { ...comment, id: String(90_000 + this.#nextComment), userId: input.userId };
      }),
    };
    this.#reviews.push(review);
    return review;
  }

  review(repo: RepoFullName, number: number, reviewId: string): FakeCiReview | undefined {
    return this.#reviews.find((review) => review.repo === repo && review.number === number && review.reviewId === reviewId);
  }

  reviews(repo: RepoFullName, number: number): readonly FakeCiReview[] {
    return this.#reviews.filter((review) => review.repo === repo && review.number === number);
  }

  /** Requests people and teams on a PR, as a person does on the host. */
  requestReviewers(repo: RepoFullName, number: number, requested: RequestedReviewers): void {
    const now = this.requestedReviewers(repo, number);
    this.#requested.set(prKey(repo, number), {
      users: [...now.users, ...requested.users.filter((user) => !now.users.some((one) => one.userId === user.userId))],
      teams: [...now.teams, ...requested.teams.filter((team) => !now.teams.some((one) => one.slug === team.slug))],
    });
  }

  /** Removes a request, as a person does, or as a review submitted by the requested person does on GitHub. */
  removeRequestedReviewer(repo: RepoFullName, number: number, who: { readonly userId: string } | { readonly slug: string }): void {
    const now = this.requestedReviewers(repo, number);
    this.#requested.set(prKey(repo, number), {
      users: "userId" in who ? now.users.filter((user) => user.userId !== who.userId) : now.users,
      teams: "slug" in who ? now.teams.filter((team) => team.slug !== who.slug) : now.teams,
    });
  }

  requestedReviewers(repo: RepoFullName, number: number): RequestedReviewers {
    return this.#requested.get(prKey(repo, number)) ?? { users: [], teams: [] };
  }

  /** Writes a file the host serves at a ref, such as a `CODEOWNERS`. */
  setFile(repo: RepoFullName, ref: string, path: string, text: string): void {
    this.#files.set(`${repo}@${ref}:${path}`, text);
  }

  /** The `CODEOWNERS` text at a ref, from the first place GitHub looks that has one, or `null`. */
  codeOwners(repo: RepoFullName, ref: string): string | null {
    for (const path of codeOwnersPaths) {
      const text = this.#files.get(`${repo}@${ref}:${path}`);
      if (text !== undefined) return text;
    }
    return null;
  }
}
