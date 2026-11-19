import { describe, expect, it } from "vitest";

import { formatUserCode, normalizeUserCode } from "./device-code";

describe("the device code", () => {
  it("drops dashes and spaces and upper-cases what was typed", () => {
    expect(normalizeUserCode(" wdjb-mjht ")).toBe("WDJBMJHT");
  });

  it("shows eight characters as two groups of four", () => {
    expect(formatUserCode("wdjbmjht")).toBe("WDJB-MJHT");
    expect(formatUserCode("ABC")).toBe("ABC");
  });
});
