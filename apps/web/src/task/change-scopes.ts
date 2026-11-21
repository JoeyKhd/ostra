import type { ChangeEntity } from "@ostra/protocol";

// Which of the panel's query groups a change notice (ADR 0035) makes stale. The switch is exhaustive
// over `ChangeEntity`, so a new kind of notice fails the build until the panel says what it refreshes.

/** A top-level tRPC router whose cached queries a notice can invalidate. */
export type QueryScope = "tasks" | "projects" | "runners" | "pools" | "providers" | "agentProfiles" | "environments" | "github" | "organization" | "me" | "boxSizes" | "fleetUse" | "registry" | "registryUse" | "automations" | "inbox" | "tickets" | "diff" | "home" | "notifications" | "previews";

export const queryScopesOf = (entity: ChangeEntity): readonly QueryScope[] => {
  switch (entity) {
    case "task":
      // Milestone 6: a task's move shows in the Inbox's rows and a parent ticket's page. Milestone 3
      // (ticket 46): `diff.fetch` sends the task's notice once a new head's diff is in and the
      // comments it outdated are marked, so an open Changes tab shows both.
      // Ticket m3-44: Home's sections and board, and the Needs you rows (an item answered elsewhere), follow a task live.
      // Milestone 8 (F-141): a task's previews, their sharing, its box and its views follow it too.
      return ["tasks", "projects", "fleetUse", "inbox", "tickets", "diff", "home", "notifications", "previews"];
    case "runner":
    case "runner-pool":
      // Milestone 5: the Box sizes page counts runners, and a project's Runners tab its pools' boxes.
      return ["runners", "pools", "fleetUse"];
    case "model-provider":
    case "model":
      return ["providers"];
    case "agent-profile":
      return ["agentProfiles"];
    case "project":
    case "environment":
      // Milestone 6: an automation's change and a bulk start's decided item send the project's notice.
      return ["projects", "environments", "fleetUse", "automations", "inbox"];
    case "connection":
      return ["github"];
    case "member":
      // A member's new notification (core's fan-out, F-036) is a member notice: Needs you, its count and Home refetch.
      return ["organization", "me", "boxSizes", "fleetUse", "registry", "registryUse", "notifications", "home"];
    case "organization":
      // A role or a name change shows in the organization's pages and in the signed-in member's own view.
      return ["organization", "me", "boxSizes", "fleetUse", "registry", "registryUse"];
    default:
      return entity satisfies never;
  }
};
