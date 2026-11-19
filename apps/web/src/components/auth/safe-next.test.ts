import { describe, expect, it } from "vitest";

import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps a same-site path", () => {
    expect(safeNext("/organization/models")).toBe("/organization/models");
    expect(safeNext("/tasks/1?tab=log")).toBe("/tasks/1?tab=log");
  });

  it("sends anything else Home", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("https://example.com")).toBe("/");
    expect(safeNext("//example.com")).toBe("/");
    expect(safeNext(String.raw`/\example.com`)).toBe("/");
  });
});
