import { describe, expect, it } from "vitest";

import { marker, unescapeMarkers } from "./stub-model.ts";

// Linear keeps a description's square brackets escaped, so a ticket's marker reaches the prompt as
// `\[\[stub:…\]\]`. The suite's stub reads it unescaped, or every ticket task would play no script.

describe("the stub model's markers", () => {
  it("reads a marker Linear escaped", () => {
    const stored = String.raw`\[\[stub:slow failure-suite/a-1.md 8 2500\]\]` + "\n\ntext";
    expect(unescapeMarkers(stored)).toBe(`${marker("slow", "failure-suite/a-1.md 8 2500")}\n\ntext`);
  });

  it("leaves a plain marker and other brackets as they are", () => {
    expect(unescapeMarkers(marker("write", "a.md"))).toBe("[[stub:write a.md]]");
    expect(unescapeMarkers(String.raw`a \[link\](x)`)).toBe(String.raw`a \[link\](x)`);
  });
});
