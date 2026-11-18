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
};
