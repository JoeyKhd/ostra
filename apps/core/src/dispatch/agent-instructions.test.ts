import { repoFullNameSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { agentInstructions, COMMITS_FOR_AGENT } from "./agent-instructions.ts";

const one = [{ fullName: repoFullNameSchema.parse("ostra-test/test1"), checkoutDir: "test1", defaultBranch: "main" }];
const two = [...one, { fullName: repoFullNameSchema.parse("ostra-test/test2"), checkoutDir: "test2", defaultBranch: "develop" }];
const branch = "ostra/abc-fix";

describe("agentInstructions", () => {
  it("F-078/c1: a code task's agent is told to write its commits in each repo's own style, from its history, and to add no author or trailer", () => {
    const commits = { commits: true } as const;
    expect(COMMITS_FOR_AGENT).toContain("in that repository's own style");
    expect(COMMITS_FOR_AGENT).toContain("`git log -n 20 --format=%s`");
    expect(COMMITS_FOR_AGENT).toContain("don't set an author or add trailers yourself");
    // With one repo and no words of the profile's, the note is the whole of it; the profile's follow.
    expect(agentInstructions(null, one, branch, null, commits)).toBe(COMMITS_FOR_AGENT);
    expect(agentInstructions("Be brief.", one, branch, null, commits)).toBe(`${COMMITS_FOR_AGENT}\n\nBe brief.`);
    // With several, after the repos' section, which still ends at the next heading.
    const several = agentInstructions("Be brief.", two, branch, null, commits) ?? "";
    expect(several.indexOf("- `test2/`: ostra-test/test2")).toBeLessThan(several.indexOf("## Commits"));
    expect(several.endsWith(`${COMMITS_FOR_AGENT}\n\nBe brief.`)).toBe(true);
    // Kept whole when the profile's text is cut to fit.
    const long = agentInstructions("x".repeat(70_000), one, branch, "## Memory\n\nnotes", commits) ?? "";
    expect(long.startsWith(COMMITS_FOR_AGENT)).toBe(true);
    expect(long.length).toBeLessThanOrEqual(65_536);
    // A task that commits nothing (a review or a refine task) isn't told.
    expect(agentInstructions(null, one, branch, null, { commits: false })).toBeNull();
    expect(agentInstructions("Be brief.", two, branch) ?? "").not.toContain("## Commits");
  });

  it("leaves the profile's instructions alone when the task has one repo (the agent starts inside it)", () => {
    expect(agentInstructions(null, one, branch)).toBeNull();
    expect(agentInstructions("Be brief.", one, branch)).toBe("Be brief.");
  });

  it("F-098/c1: names each repo's folder, base branch and the task's branch when the task has several", () => {
    const text = agentInstructions(null, two, branch);
    expect(text).toContain("- `test1/`: ostra-test/test1 (base: main)");
    expect(text).toContain("- `test2/`: ostra-test/test2 (base: develop)");
    expect(text).toContain("`ostra/abc-fix`");
  });

  it("puts the profile's own instructions after the folders", () => {
    const text = agentInstructions("Be brief.", two, branch);
    expect(text?.endsWith("\n\nBe brief.")).toBe(true);
    expect(text?.indexOf("test2/")).toBeLessThan(text?.indexOf("Be brief.") ?? -1);
  });

  it("stays inside the spec's limit, keeping the folders", () => {
    const text = agentInstructions("x".repeat(70_000), two, branch);
    expect(text?.length).toBeLessThanOrEqual(65_536);
    expect(text).toContain("- `test2/`: ostra-test/test2");
  });

  it("F-110/c1: a minor-2 runner's memory block comes last, kept whole when the profile's text is cut", () => {
    const block = "## Memory\n\nnotes";
    expect(agentInstructions("Be brief.", one, branch, block)).toBe("Be brief.\n\n## Memory\n\nnotes");
    expect(agentInstructions(null, one, branch, block)).toBe(block);
    const long = agentInstructions("x".repeat(70_000), two, branch, block);
    expect(long?.endsWith(block)).toBe(true);
    expect(long?.length).toBeLessThanOrEqual(65_536);
  });
});
