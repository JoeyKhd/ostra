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
};
