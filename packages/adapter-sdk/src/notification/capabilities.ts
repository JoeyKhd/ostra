/** What a notification adapter can do (ADR 0025). */
export type NotificationCapabilities = {
  /** The channels it delivers to, such as `panel`, `email` or `linear`. */
  readonly channels: readonly string[];
  /** Milestone 3: `update` edits a sent notification in place (the tracker's comment yes, email no). */
  readonly edits: boolean;
};
