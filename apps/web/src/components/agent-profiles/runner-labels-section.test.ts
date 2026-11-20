import { describe, expect, it } from "vitest";

import { labelRefusal } from "./runner-labels-section";

// F-069 (ticket 32): a profile's runner labels, refused inline before the API is asked.

describe("a profile's runner labels", () => {
  it("F-069: refuses the reserved prefixes, a malformed label and a repeat", () => {
    expect(labelRefusal("executor:docker", [])).toContain("executor: labels come from what a runner reports");
    expect(labelRefusal("os:linux", [])).toContain("os: labels");
    expect(labelRefusal("arch:arm64", [])).toContain("arch: labels");
    expect(labelRefusal("Tier Fast", [])).toContain("A label is lowercase letters");
    expect(labelRefusal("tier:fast", ["tier:fast"])).toBe("tier:fast is listed already.");
    expect(labelRefusal("tier:fast", [])).toBeNull();
    expect(labelRefusal("executors:x", [])).toBeNull();
  });
});
