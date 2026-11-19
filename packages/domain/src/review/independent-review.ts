import type { GitSha, MemberId } from "@ostra/protocol";

// The `ostra/independent-review` check's evaluator (F-104, ADR 0040 amended, Q207), ported from
// spikes/github-app-and-git-proxy/src/github/independent-review.ts. It passes when a GitHub user
// linked to an active member who didn't drive the task approved the PR's current head. Each
// reviewer's latest approval, change request or dismissal counts; a comment doesn't; bots and
// drivers don't count, and neither does a reviewer with no verified link. Pure.

export const INDEPENDENT_REVIEW_CHECK_NAME = "ostra/independent-review";

/** A review as `CodeHostAdapter.listReviews` returns it. */
export type ReviewLite = {
  /** The reviewer's code host user ID: what a verified link names (F-119). */
  readonly userId: string;
  readonly login: string;
  readonly isBot: boolean;
  readonly state: "approved" | "changes_requested" | "commented" | "dismissed" | "pending";
  /** The commit the review was of. */
  readonly commitId: string;
  /** When it was submitted, in ms since the epoch. */
  readonly submittedAt: number;
};

export type IndependentReviewInput = {
  readonly reviews: readonly ReviewLite[];
  /** Every member credited with a trailer on the task (Q121). */
  readonly drivers: ReadonlySet<MemberId>;
  /** Code host user ID → the active member it's verified for. Removed members aren't in it. */
  readonly links: ReadonlyMap<string, MemberId>;
  readonly headSha: GitSha;
};

export type PendingReason =
  | "no-approval"
  | "changes-requested"
  | "only-bots-approved"
  | "only-unlinked-approved"
  | "only-drivers-approved"
  | "approval-is-stale";

export type IndependentReviewVerdict =
  | { readonly status: "passed"; readonly approverMemberId: MemberId; readonly approverLogin: string }
  | { readonly status: "pending"; readonly reason: PendingReason };

const DECIDING: ReadonlySet<ReviewLite["state"]> = new Set(["approved", "changes_requested", "dismissed"]);

export const evaluateIndependentReview = (input: IndependentReviewInput): IndependentReviewVerdict => {
  // A comment doesn't change a reviewer's standing; an approval, a change request or a dismissal
  // does, and the latest of those counts.
  const latest = new Map<string, ReviewLite>();
  for (const review of [...input.reviews].sort((x, y) => x.submittedAt - y.submittedAt)) {
    if (DECIDING.has(review.state)) {
      latest.set(review.userId, review);
    }
  }
  const standing = [...latest.values()];
  const approvals = standing.filter((review) => review.state === "approved");
  if (approvals.length === 0) {
    return { status: "pending", reason: standing.some((review) => review.state === "changes_requested") ? "changes-requested" : "no-approval" };
  }
  const people = approvals.filter((review) => !review.isBot);
  if (people.length === 0) {
    return { status: "pending", reason: "only-bots-approved" };
  }
  const linked = people.flatMap((review) => {
    const memberId = input.links.get(review.userId);
    return memberId === undefined ? [] : [{ review, memberId }];
  });
  if (linked.length === 0) {
    return { status: "pending", reason: "only-unlinked-approved" };
  }
  const independent = linked.filter((entry) => !input.drivers.has(entry.memberId));
  if (independent.length === 0) {
    return { status: "pending", reason: "only-drivers-approved" };
  }
  const current = independent.filter((entry) => entry.review.commitId === input.headSha);
  const first = current[0];
  if (first === undefined) {
    return { status: "pending", reason: "approval-is-stale" };
  }
  return { status: "passed", approverMemberId: first.memberId, approverLogin: first.review.login };
};

/** The check's summary, for the code host and the thread: never a review's text. */
export const pendingReasonWords = (reason: PendingReason): string => {
  switch (reason) {
    case "no-approval":
      return "Waiting for an approval from a member who didn't drive this task.";
    case "changes-requested":
      return "A reviewer asked for changes.";
    case "only-bots-approved":
      return "Only bots approved: a person's approval is needed.";
    case "only-unlinked-approved":
      return "The approval is from a GitHub account no member has linked in ostra.";
    case "only-drivers-approved":
      return "Only the task's drivers approved: someone else's approval is needed.";
    case "approval-is-stale":
      return "The approval is of an earlier commit: the current head needs one.";
    default:
      return reason satisfies never;
  }
};
