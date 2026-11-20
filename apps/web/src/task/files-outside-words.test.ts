import { describe, expect, it } from "vitest";

import { filesOutsideText } from "./files-outside-words";

describe("the thread's line for files outside the repos", () => {
  it("F-016/c4: names the files and says what to do: reply to have them moved, or dismiss", () => {
    expect(filesOutsideText({ paths: ["notes.md", "plan.txt"], more: 0 })).toBe(
      "The agent left 2 files outside the repositories: notes.md, plan.txt. Reply to have them moved into a repository, or dismiss.",
    );
    expect(filesOutsideText({ paths: ["notes.md"], more: 0 })).toBe(
      "The agent left 1 file outside the repositories: notes.md. Reply to have them moved into a repository, or dismiss.",
    );
    expect(filesOutsideText({ paths: ["a.txt", "b.txt"], more: 3 })).toBe(
      "The agent left 5 files outside the repositories: a.txt, b.txt and 3 more. Reply to have them moved into a repository, or dismiss.",
    );
  });

  it("F-016/c4: says when none are left", () => {
    expect(filesOutsideText({ paths: [], more: 0 })).toBe("No files are left outside the repositories now.");
  });
});
