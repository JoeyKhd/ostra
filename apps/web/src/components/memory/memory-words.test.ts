import { describe, expect, it } from "vitest";

import { bodySize, conflictOf, secretFoundOf, sourceFilterOf } from "./memory-words";

// F-109, F-111 (ticket 38): the words Memory builds from the API's refusals, and the Source filter.

describe("memory words", () => {
  it("F-109/c4: a secret refusal names its kind from the API's message, and a stale save who saved first", () => {
    expect(secretFoundOf("This note holds a GitHub token, so it wasn't saved. Remove it and save again.")).toBe("a GitHub token");
    expect(secretFoundOf("This note holds a GitHub token, an AWS access key, so it wasn't saved. Remove it and save again.")).toBe("a GitHub token, an AWS access key");
    expect(secretFoundOf("Version 3 was saved by Sam Rivera since you opened this note.")).toBeNull();
    expect(conflictOf("Version 3 was saved by Sam Rivera since you opened this note.")).toEqual({ version: 3, name: "Sam Rivera" });
    expect(conflictOf("This note holds a GitHub token, so it wasn't saved.")).toBeNull();
  });

  it("F-109: a body's size against the 4 KiB limit, in bytes of UTF-8", () => {
    expect(bodySize("abc")).toEqual({ bytes: 3, text: "3 B of 4 KiB" });
    expect(bodySize("é".repeat(700)).text).toBe("1.4 KiB of 4 KiB");
  });

  it("F-111: an agent's proposal and its closing turn fall under the agent's Source filter", () => {
    expect(sourceFilterOf("task")).toBe("agent");
    expect(sourceFilterOf("proposal")).toBe("agent");
    expect(sourceFilterOf("diff_comment")).toBe("diff_comment");
    expect(sourceFilterOf("member")).toBe("member");
  });
});
