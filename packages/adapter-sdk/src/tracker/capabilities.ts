/** What a tracker adapter can do (ADR 0025). Optional abilities are declared, never assumed. */
export type TrackerCapabilities = {
  /** The tracker shows an agent's session natively (Linear's agent sessions). */
  readonly agentSessions: boolean;
  /** Tickets have sub-issues, each its own task (F-077). */
  readonly subIssues: boolean;
  /** Statuses form a graph the adapter can read, so "ready" and "in review" map to real statuses. */
  readonly statusGraph: boolean;
};
