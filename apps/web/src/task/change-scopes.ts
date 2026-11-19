import type { ChangeEntity } from "@ostra/protocol";

// Which of the panel's query groups a change notice (ADR 0035) makes stale. The switch is exhaustive
// over `ChangeEntity`, so a new kind of notice fails the build until the panel says what it refreshes.

/** A top-level tRPC router whose cached queries a notice can invalidate. */
export type QueryScope = "tasks" | "projects" | "runners" | "pools" | "providers" | "agentProfiles" | "environments" | "github" | "organization" | "me";

export const queryScopesOf = (entity: ChangeEntity): readonly QueryScope[] => {
  switch (entity) {
    case "task":
      return ["tasks", "projects"];
    case "runner":
    case "runner-pool":
      return ["runners", "pools"];
    case "model-provider":
    case "model":
      return ["providers"];
    case "agent-profile":
      return ["agentProfiles"];
    case "project":
    case "environment":
      return ["projects", "environments"];
    case "connection":
      return ["github"];
    case "member":
    case "organization":
      // A role or a name change shows in the organization's pages and in the signed-in member's own view.
      return ["organization", "me"];
    default:
      return entity satisfies never;
  }
};
