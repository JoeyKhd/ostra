import { changeEntities } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import { queryScopesOf } from "./change-scopes";

describe("queryScopesOf", () => {
  it("names at least one query group for every kind of change notice", () => {
    for (const entity of changeEntities) {
      expect(queryScopesOf(entity).length, entity).toBeGreaterThan(0);
    }
  });

  it("refreshes the pools for a runner pool or a runner", () => {
    expect(queryScopesOf("runner-pool")).toEqual(expect.arrayContaining(["runners", "pools"]));
    expect(queryScopesOf("runner")).toEqual(expect.arrayContaining(["runners", "pools"]));
  });

  it("F-095: refreshes the box sizes and the fleet's counts for an organization, a runner, a project or a task change", () => {
    expect(queryScopesOf("organization")).toEqual(expect.arrayContaining(["boxSizes", "fleetUse"]));
    // F-120: a registry check's result arrives as an organization notice.
    expect(queryScopesOf("organization")).toEqual(expect.arrayContaining(["registry", "registryUse"]));
    for (const entity of ["runner", "project", "task"] as const) expect(queryScopesOf(entity)).toContain("fleetUse");
  });

  it("refreshes the organization and the member's own view for a member or organization change", () => {
    for (const entity of ["member", "organization"] as const) {
      expect(queryScopesOf(entity)).toEqual(expect.arrayContaining(["organization", "me"]));
    }
  });
});
