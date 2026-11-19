/** What a code host adapter can do (ADR 0025). */
export type CodeHostCapabilities = {
  /** The host has check runs ostra can write (`checks: write`, F-054). */
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
};
