import { taskSpecFixture } from "@ostra/protocol/testing";
import { describe, expect, it } from "vitest";
import { agentCwd } from "./agent-cwd.ts";

const [repo] = taskSpecFixture.repos;
if (repo === undefined) {
  throw new Error("the fixture has a repo");
}

describe("agentCwd", () => {
  it("is the repo's checkout when the task has one repo", () => {
    expect(agentCwd("/workspace", [repo])).toBe(`/workspace/${repo.checkoutDir}`);
  });

  it("keeps the separator of the executor's path", () => {
    expect(agentCwd("C:\\data\\tasks\\t1\\workspace", [repo])).toBe(`C:\\data\\tasks\\t1\\workspace\\${repo.checkoutDir}`);
    expect(agentCwd("/workspace/", [repo])).toBe(`/workspace/${repo.checkoutDir}`);
  });

  it("is the workspace root when the task has several repos", () => {
    expect(agentCwd("/workspace", [repo, { ...repo, checkoutDir: "test2" }])).toBe("/workspace");
  });

  it("is the workspace root when the task has no repo", () => {
    expect(agentCwd("/workspace", [])).toBe("/workspace");
  });
});
