/** What a tracker adapter can do (ADR 0025). Optional abilities are declared, never assumed. */
export type TrackerCapabilities = {
  /** The tracker shows an agent's session natively (Linear's agent sessions, milestone 6). */
  readonly agentSessions: boolean;
  /** Tickets have sub-issues, each its own task (F-077). */
  readonly subIssues: boolean;
  /** Statuses form a graph the adapter can read, so "ready" and "in review" map to real statuses. */
  readonly statusGraph: boolean;
  /** Milestone 2: the tracker can push events (`verifyWebhook`, `parseWebhook`). Without it, ostra polls. */
  readonly webhooks: boolean;
  /** Milestone 2: ostra's own comment can be edited in place (`updateComment`, ADR 0047). */
  readonly commentEdit: boolean;
  /** Milestone 2: the ticket can take file copies (ADR 0043); Linear yes, used from milestone 6. */
  readonly attachments: boolean;
  /** Milestone 2: moves go through a transition graph (Jira), not a direct status write (Linear). */
  readonly transitions: boolean;
};
