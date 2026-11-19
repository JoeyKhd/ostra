import { describe, expect, it } from "vitest";

import { orderPermissions } from "./permission-order";

describe("orderPermissions", () => {
  it("lists the manifest's permissions in its order, then the others A–Z", () => {
    const ordered = orderPermissions({ metadata: "read", checks: "write", zeta: "read", administration: "read", contents: "write", actions: "read" });
    expect(ordered.map(([name]) => name)).toEqual(["contents", "checks", "actions", "metadata", "administration", "zeta"]);
  });

  it("keeps each permission's level", () => {
    expect(orderPermissions({ pull_requests: "write" })).toEqual([["pull_requests", "write"]]);
  });
});
