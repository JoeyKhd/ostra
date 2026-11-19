import type { RepoFullName } from "@ostra/protocol";

import type { CheckRunInput, PublishedCheckRun, PullRequestReview } from "../code-host/base.ts";

// Milestone 4 (ticket 03, F-104, ADR 0040): the reviews, check runs and branch protection of a fake
// code host, in memory. The tiny code host keeps its state here, and any other fake host (core's,
// GitHub's) can too. A check run is one per `(repo, headSha, name)`, as GitHub keys a check suite's
// runs. Branch protection that requires a named check has two modes, so both answers of ADR 0040's
// open question are tested whichever way GitHub answers it:
// - `in_progress-blocks`: a required check that hasn't completed blocks the merge, as a failing one does;
// - `only-failing-blocks`: only a completed check that isn't `success` blocks it, so an `in_progress`
//   check lets the merge through, and the check must report `action_required` instead.
// A required check that never ran blocks the merge in both modes, as GitHub's "Expected" does.

export type BranchProtectionMode = "in_progress-blocks" | "only-failing-blocks";

export type BranchProtection = { readonly requiredCheck: string; readonly mode: BranchProtectionMode };

/** A check run as the fake keeps it. */
export type FakeCheckRun = CheckRunInput & { readonly checkRunId: string; readonly repo: RepoFullName };

/** What a merge on the fake host met: through, or refused with the reason the host would show. */
export type FakeMergeOutcome = { readonly merged: true } | { readonly merged: false; readonly reason: string };

/** A review to add: everything but its ID, which the fake gives. */
export type FakeReviewInput = Omit<PullRequestReview, "reviewId">;

const prKey = (repo: RepoFullName, number: number): string => `${repo}#${String(number)}`;
const branchKey = (repo: RepoFullName, branch: string): string => `${repo}@${branch}`;

export class FakeReviewsAndChecks {
  readonly #reviews = new Map<string, PullRequestReview[]>();
  readonly #runs: FakeCheckRun[] = [];
  readonly #protection = new Map<string, BranchProtection>();
  #nextReview = 0;
  #nextRun = 0;

  /** Adds a submitted (or pending) review to a PR, after the ones it has: the host lists them oldest first. */
  addReview(repo: RepoFullName, number: number, review: FakeReviewInput): PullRequestReview {
    this.#nextReview += 1;
    const added: PullRequestReview = { ...review, reviewId: `review-${String(this.#nextReview)}` };
    const key = prKey(repo, number);
    this.#reviews.set(key, [...(this.#reviews.get(key) ?? []), added]);
    return added;
  }

  /** Dismisses a review, as a maintainer does on the host: it stays listed, as `dismissed`. */
  dismissReview(repo: RepoFullName, number: number, reviewId: string): PullRequestReview {
    const key = prKey(repo, number);
    const reviews = this.#reviews.get(key) ?? [];
    const index = reviews.findIndex((review) => review.reviewId === reviewId);
    const found = reviews[index];
    if (found === undefined) throw new Error("no such review");
    const dismissed: PullRequestReview = { ...found, state: "dismissed" };
    reviews[index] = dismissed;
    return dismissed;
  }

  /** A PR's reviews, oldest first. */
  reviews(repo: RepoFullName, number: number): readonly PullRequestReview[] {
    return [...(this.#reviews.get(prKey(repo, number)) ?? [])];
  }

  /** Publishes a check run, or answers the one that exists for its head and name. */
  publish(repo: RepoFullName, input: CheckRunInput): PublishedCheckRun {
    const existing = this.#runs.find((run) => run.repo === repo && run.headSha === input.headSha && run.name === input.name);
    if (existing !== undefined) {
      return { checkRunId: existing.checkRunId };
    }
    this.#nextRun += 1;
    const checkRunId = `check-run-${String(this.#nextRun)}`;
    this.#runs.push({ ...input, repo, checkRunId });
    return { checkRunId };
  }

  /** Writes a run's new state and words; `false` when the repo has no such run. Its head and name stay. */
  update(repo: RepoFullName, checkRunId: string, input: CheckRunInput): boolean {
    const index = this.#runs.findIndex((run) => run.repo === repo && run.checkRunId === checkRunId);
    const found = this.#runs[index];
    if (found === undefined) {
      return false;
    }
    this.#runs[index] = { ...input, repo, checkRunId, headSha: found.headSha, name: found.name };
    return true;
  }

  checkRun(checkRunId: string): FakeCheckRun | undefined {
    return this.#runs.find((run) => run.checkRunId === checkRunId);
  }

  /** The runs on a head, by name when given. */
  checkRuns(repo: RepoFullName, headSha: string, name?: string): readonly FakeCheckRun[] {
    return this.#runs.filter((run) => run.repo === repo && run.headSha === headSha && (name === undefined || run.name === name));
  }

  /** Sets branch protection that requires a check, in one of the two modes; `null` removes it. */
  protect(repo: RepoFullName, branch: string, protection: BranchProtection | null): void {
    if (protection === null) {
      this.#protection.delete(branchKey(repo, branch));
    } else {
      this.#protection.set(branchKey(repo, branch), protection);
    }
  }

  /** Whether a PR into `baseBranch` at `headSha` may merge, by the base's protection. */
  merge(repo: RepoFullName, baseBranch: string, headSha: string): FakeMergeOutcome {
    const protection = this.#protection.get(branchKey(repo, baseBranch));
    if (protection === undefined) {
      return { merged: true };
    }
    const [run] = this.checkRuns(repo, headSha, protection.requiredCheck);
    if (run === undefined) {
      return { merged: false, reason: `the required check ${protection.requiredCheck} is expected and hasn't run` };
    }
    if (run.status === "in_progress") {
      return protection.mode === "in_progress-blocks"
        ? { merged: false, reason: `the required check ${protection.requiredCheck} is in progress` }
        : { merged: true };
    }
    return run.conclusion === "success" ? { merged: true } : { merged: false, reason: `the required check ${protection.requiredCheck} needs action` };
  }
}
