import type { NotificationKind } from "@ostra/adapter-sdk";

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
