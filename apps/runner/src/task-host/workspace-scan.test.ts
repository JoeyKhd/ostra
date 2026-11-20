import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";

import { filesOutsideRepos, outsideKey } from "./workspace-scan.ts";

const [base] = taskSpecFixture.repos;
if (base === undefined) {
  throw new Error("the fixture has a repo");
}
const spec = { repos: [base, { ...base, checkoutDir: "test2" }] };

describe("the workspace root's scan", () => {
  it("F-016/c4: leaves out the repos' checkouts and ostra's own folder, sorted, at most 50 with how many more", () => {
    const checkout = taskSpecFixture.repos[0]?.checkoutDir ?? "";
    expect(filesOutsideRepos([checkout, "test2", ".ostra", "plan.txt", "notes.md"], spec)).toEqual({ paths: ["notes.md", "plan.txt"], more: 0 });
    expect(filesOutsideRepos([checkout, "test2", ".ostra"], spec)).toEqual({ paths: [], more: 0 });
    const many = Array.from({ length: 53 }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`);
    const found = filesOutsideRepos(many, spec);
    expect(found.paths).toHaveLength(50);
    expect(found.paths[0]).toBe("file-00.txt");
    expect(found.more).toBe(3);
  });

  it("F-016/c4: sees a change past the first 50, and none when only the order changed", () => {
    const many = Array.from({ length: 51 }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`);
    expect(outsideKey(many, spec)).toBe(outsideKey([...many].reverse(), spec));
    expect(outsideKey(many, spec)).not.toBe(outsideKey([...many.slice(0, 50), "other.txt"], spec));
  });
});
