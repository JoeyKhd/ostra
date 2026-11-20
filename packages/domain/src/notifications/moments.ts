import type { NotificationKind, TeamNotificationKind } from "@ostra/adapter-sdk";

/**
 * Each moment's heading (ADR 0050): the mail's title, the ticket comment's first words and the
 * notification's title in the panel. One table, so the three never say it differently.
 */
export const momentHeading: Readonly<Record<NotificationKind, string>> = {
  approval: "An approval is waiting",
  question: "A question for you",
  plan: "A plan to approve",
  pr_ready: "A pull request is ready",
  no_changes: "The agent changed nothing",
  stalled: "A task stalled",
  spend_cap: "A task reached its spend cap",
  crashed: "A task crashed",
  setup_failed: "A task's setup failed",
  ticket_closed: "The ticket closed while the agent worked",
  test: "Mail works",
};

/** Milestone 6's moments' headings (the adapter SDK's `teamNotificationKinds`): the mail's title and the panel's. */
export const teamMomentHeading = {
  draft_ready: "A draft is ready",
  review_requested: "A PR waits for your review",
  task_approval: "A task waits for approval",
  round_cap: "A task needs you",
  automation_paused: "An automation paused",
} as const satisfies Readonly<Record<TeamNotificationKind, string>>;

/** Every needs-you moment's heading: milestone 3's and milestone 6's, in one table. */
export const anyMomentHeading: Readonly<Record<NotificationKind | TeamNotificationKind, string>> = { ...momentHeading, ...teamMomentHeading };
