import { repoFullNameSchema } from "@ostra/protocol";
import { describe, expect, it } from "vitest";
import { agentInstructions } from "./agent-instructions.ts";

const one = [{ fullName: repoFullNameSchema.parse("ostra-test/test1"), checkoutDir: "test1", defaultBranch: "main" }];
const two = [...one, { fullName: repoFullNameSchema.parse("ostra-test/test2"), checkoutDir: "test2", defaultBranch: "develop" }];
const branch = "ostra/abc-fix";

describe("agentInstructions", () => {
  it("leaves the profile's instructions alone when the task has one repo (the agent starts inside it)", () => {
    expect(agentInstructions(null, one, branch)).toBeNull();
    expect(agentInstructions("Be brief.", one, branch)).toBe("Be brief.");
  });

  it("F-098: names each repo's folder, base branch and the task's branch when the task has several", () => {
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

  it("F-110: a minor-2 runner's memory block comes last, kept whole when the profile's text is cut", () => {
    const block = "## Memory\n\nnotes";
    expect(agentInstructions("Be brief.", one, branch, block)).toBe("Be brief.\n\n## Memory\n\nnotes");
    expect(agentInstructions(null, one, branch, block)).toBe(block);
    const long = agentInstructions("x".repeat(70_000), two, branch, block);
    expect(long?.endsWith(block)).toBe(true);
    expect(long?.length).toBeLessThanOrEqual(65_536);
  });
});
