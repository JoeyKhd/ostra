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
  /** Milestone 3: `findUsersByEmail` matches members to tracker users, whose mention notifies them (F-036). */
  readonly mentions: boolean;
  /**
   * Milestone 6 (F-012): the scopes agent mode needs on the install's token (Linear:
   * `app:assignable`, `app:mentionable`), so core can tell a stored token lacks them. Empty
   * without `agentSessions`.
   */
  readonly agentScopes: readonly string[];
  /** Milestone 6: `setAgentSessionLink` sets the session's link to the task, where the tracker has one. */
  readonly agentSessionLink: boolean;
  /**
   * Milestone 6 (F-099): the structured fields a ticket can take beside its description. A field
   * the tracker can't take goes into the description instead (Linear has none).
   */
  readonly ticketFields: { readonly acceptanceCriteria: boolean };
};
