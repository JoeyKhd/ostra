/**
 * Milestone 9 (F-149, ADR 0070): which of a ticket's files `getTicketContext` lists in `files`.
 * `all`: every file the tracker holds, inline or attached, of any type. `images`: images only.
 * `none`: no file, and tasks start from the ticket's text.
 */
export type TicketFilesCapability = "all" | "images" | "none";

export const ticketFilesCapabilities: readonly TicketFilesCapability[] = ["all", "images", "none"];

/**
 * Milestone 11 (F-008): what the tracker stores a ticket's text as. The adapter always takes and
 * gives markdown; this is the panel's `Rich text` row (`Markdown`, `ADF, converted`).
 */
export type TrackerRichText = "markdown" | "adf";

export const trackerRichTexts: readonly TrackerRichText[] = ["markdown", "adf"];

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
  /**
   * F-153 (spec section 5.2): the adapter can create and delete its own webhooks on a board
   * (`ensureBoardWebhook`, `removeBoardWebhook`). Trello yes; Linear and Jira are registered by an
   * admin, so no. Without it, both methods answer `unsupported`.
   */
  readonly webhookRegistration: boolean;
  /** Milestone 2: ostra's own comment can be edited in place (`updateComment`, ADR 0047). */
  readonly commentEdit: boolean;
  /**
   * Milestone 2: the ticket can take file copies (ADR 0043); Linear yes, used from milestone 6.
   * `attachFile` and `listAttachments` (which reads back each attachment's marker) come with it.
   */
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
  /**
   * Milestone 9 (F-149): the files a ticket's context lists (`TicketContext.files`) and a piece of
   * its text names (`filesInText`), each fetched with `downloadFile`.
   */
  readonly ticketFiles: TicketFilesCapability;
  /**
   * Milestone 11 (F-008, spec section 5.2): a PR's body links the ticket with the board's magic
   * word (`Closes`, `Refs`). Linear yes; Jira no, as its GitHub integration links by the key in the
   * branch and the title, which ostra always writes. Without it the panel draws no magic-word row,
   * and `linkPullRequest`'s `kind` is ignored.
   */
  readonly magicWords: boolean;
  /** Milestone 11 (F-008): what the tracker stores a ticket's text as; the adapter converts. */
  readonly richText: TrackerRichText;
  /**
   * Milestone 11 (F-008): the tracker's events can be narrowed by a query on its side (Jira's admin
   * webhook JQL), shown as a row of the connect steps. Linear no.
   */
  readonly jqlFilter: boolean;
};
