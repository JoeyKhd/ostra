import { describe, expect, it } from "vitest";

import { entriesText, lineCount, withoutFinalNewline } from "./environment-words";

describe("entriesText", () => {
  it("counts each kind, leaving out a kind that has none", () => {
    expect(entriesText(["variable", "variable", "secret", "secret", "file"])).toBe("2 variables · 2 secrets · 1 file");
    expect(entriesText(["secret"])).toBe("1 secret");
    expect(entriesText([])).toBe("");
  });
});

describe("lineCount", () => {
  it("counts lines, not a final newline", () => {
    expect(lineCount("{\n  \"port\": 4000\n}\n")).toBe(3);
    expect(lineCount("one")).toBe(1);
    expect(lineCount("")).toBe(0);
  });
});

describe("withoutFinalNewline", () => {
  it("drops one final newline only", () => {
    expect(withoutFinalNewline("corepack enable\npnpm install\n")).toBe("corepack enable\npnpm install");
    expect(withoutFinalNewline("a\n\n")).toBe("a\n");
  });
});
