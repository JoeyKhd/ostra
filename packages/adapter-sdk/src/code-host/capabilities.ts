/** What a code host adapter can do (ADR 0025). */
export type CodeHostCapabilities = {
  /** The host has check runs ostra can write (`checks: write`, F-054): `publishCheckRun` and `updateCheckRun` (milestone 4). */
  readonly checkRuns: boolean;
  /** The host has PR templates the agent fills in (F-078). */
  readonly prTemplates: boolean;
  /**
   * The hosts an LFS batch answer may send the git proxy to (ADR 0030, Q119). Empty: the host has
   * no LFS, or the proxy refuses every LFS action.
   */
  readonly lfsActionHosts: readonly string[];
  /**
   * Milestone 2 (F-055, F-060): `readBranchRules` reads whether a branch is protected and requires
   * signed commits. Without it, `readBranchRules` answers `unsupported`, and the panel shows both checks as unknown.
   */
  readonly branchRules: boolean;
  // ---- milestone 3 (ADR 0051, ADR 0052) ----
  /** `compare` reads a base and a head's files and counts (F-027, F-070). */
  readonly compare: boolean;
  /** `setPullRequestDraft` makes a PR a draft and back (F-054). */
  readonly draftPullRequests: boolean;
  /** The webhooks carry PR comments, and `addReaction` reacts to one (F-053). */
  readonly prComments: boolean;
  /** `userAuthorizeUrl` and `exchangeUserCode` verify a member's own account (F-119). */
  readonly userLink: boolean;
  // ---- milestone 4 (F-104, ADR 0040) ----
  /** `listReviews` and the `pull_request_review` webhook. Check runs are `checkRuns`. */
  readonly reviews: boolean;
  // ---- milestone 4 (F-136, ADR 0065) ----
  /**
   * Accounts other than the App's owner can install it (a public App), `removeInstallation`
   * uninstalls one, and the webhooks carry `installation` and `installation_repositories`.
   */
  readonly installableByOtherAccounts: boolean;
  // ---- milestone 6 (F-035, F-100, F-102, F-105, ADR 0058) ----
  /** `listCiResults` reads a head's check runs and commit statuses, other apps' included. */
  readonly ciResults: boolean;
  /** `getCiLog` reads the tail of a check run's log (or a status's words). */
  readonly ciLogs: boolean;
  /** `createReview` posts a comment-type review with line comments, `diffLines` says where one may sit, and `listReviewComments` reads a review's. */
  readonly reviewComments: boolean;
  /** `listRequestedReviewers` reads a PR's requested people and teams. */
  readonly requestedReviewers: boolean;
  /** `readCodeOwners` reads the repo's `CODEOWNERS` file at a ref. */
  readonly codeOwners: boolean;
};
