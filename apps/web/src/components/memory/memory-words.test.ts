import { describe, expect, it } from "vitest";

import { bodySize, conflictOf, secretFoundOf, sourceFilterOf, usedText, versionSourceParts } from "./memory-words";

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

describe("the note panel's Used and a version's Source (memory-note.md)", () => {
  it("F-109: Used reads the uses and the tasks they were in", () => {
    expect(usedText(9, 6)).toBe("9 times in 6 tasks");
    expect(usedText(1, 1)).toBe("1 time in 1 task");
  });

  it("F-109: a version's Source names the agent or the member and the task's key, and leaves out a task the viewer can't open", () => {
    const task = { taskId: "01900000-0000-7000-8000-0000000000a1", key: "CALC-161" };
    expect(versionSourceParts({ kind: "agent", agent: "OpenCode", by: null, task })).toEqual([{ text: "proposed by OpenCode in " }, { task }]);
    expect(versionSourceParts({ kind: "diff_comment", agent: null, by: { name: "Sam Rivera" }, task })).toEqual([{ text: "Sam Rivera's diff comment on " }, { task }]);
    expect(versionSourceParts({ kind: "closing_turn", agent: "OpenCode", by: null, task })).toEqual([{ text: "the closing turn of " }, { task }]);
    expect(versionSourceParts({ kind: "agent", agent: "OpenCode", by: null, task: null })).toEqual([{ text: "proposed by OpenCode" }]);
  });
});
