import type { ChangeEntity } from "@ostra/protocol";

// Which of the panel's query groups a change notice (ADR 0035) makes stale. The switch is exhaustive
// over `ChangeEntity`, so a new kind of notice fails the build until the panel says what it refreshes.

/** A top-level tRPC router whose cached queries a notice can invalidate. */
export type QueryScope = "tasks" | "projects" | "runners" | "pools" | "providers" | "agentProfiles" | "environments" | "github" | "organization" | "me" | "boxSizes" | "fleetUse" | "registry" | "registryUse" | "automations" | "inbox";

export const queryScopesOf = (entity: ChangeEntity): readonly QueryScope[] => {
  switch (entity) {
    case "task":
      return ["tasks", "projects", "fleetUse"];
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
    case "organization":
      // A role or a name change shows in the organization's pages and in the signed-in member's own view.
      return ["organization", "me", "boxSizes", "fleetUse", "registry", "registryUse"];
    default:
      return entity satisfies never;
  }
};
