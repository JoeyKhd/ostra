import { describe, expect, it } from "vitest";

import { adminNames } from "./no-key-words";

// F-135 (no-key-for-model.md, open point 3): who can fix a missing key, by name and never by address.

describe("adminNames", () => {
  it("F-135: names one or two admins with a comma, and three or more with `and` before the last", () => {
    expect(adminNames(["Alex Kim"])).toBe("Organization admins: Alex Kim.");
    expect(adminNames(["Alex Kim", "Priya Nair"])).toBe("Organization admins: Alex Kim, Priya Nair.");
    expect(adminNames(["Alex Kim", "Priya Nair", "Dana Ortiz"])).toBe("Organization admins: Alex Kim, Priya Nair and Dana Ortiz.");
  });
});
