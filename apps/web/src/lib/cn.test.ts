import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
  it("keeps a colour beside the panel's own type sizes", () => {
    expect(cn("text-ink", "text-body")).toBe("text-ink text-body");
    expect(cn("text-muted", "text-lede")).toBe("text-muted text-lede");
    expect(cn("text-faint", "text-ui")).toBe("text-faint text-ui");
  });

  it("lets a later size or colour win", () => {
    expect(cn("text-body", "text-sm")).toBe("text-sm");
    expect(cn("text-ink", "text-red")).toBe("text-red");
  });
});
