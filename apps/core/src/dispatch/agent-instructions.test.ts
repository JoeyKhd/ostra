import { describe, expect, it } from "vitest";
import { agentInstructions } from "./agent-instructions.ts";

const one = [{ fullName: "ostra-test/test1", checkoutDir: "test1" }];
const two = [...one, { fullName: "ostra-test/test2", checkoutDir: "test2" }];

describe("agentInstructions", () => {
  it("leaves the profile's instructions alone when the task has one repo (the agent starts inside it)", () => {
    expect(agentInstructions(null, one)).toBeNull();
    expect(agentInstructions("Be brief.", one)).toBe("Be brief.");
  });

  it("names each repo's folder when the task has several", () => {
    const text = agentInstructions(null, two);
    expect(text).toContain("- test1/ is ostra-test/test1");
    expect(text).toContain("- test2/ is ostra-test/test2");
    expect(text).toContain("inside the folder of the repository it concerns");
  });

  it("puts the profile's own instructions after the folders", () => {
    const text = agentInstructions("Be brief.", two);
    expect(text?.endsWith("\n\nBe brief.")).toBe(true);
    expect(text?.indexOf("test2/")).toBeLessThan(text?.indexOf("Be brief.") ?? -1);
  });

  it("stays inside the spec's limit, keeping the folders", () => {
    const text = agentInstructions("x".repeat(70_000), two);
    expect(text?.length).toBe(65_536);
    expect(text).toContain("- test2/ is ostra-test/test2");
  });
});
