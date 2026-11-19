import { describe, expect, it } from "vitest";

import { taskIdSchema } from "@ostra/protocol";

import { branchSlugFor, slugify, titleFromPrompt } from "./branch-name.ts";
import { branchNameFor } from "./use-cases/create-prompt-task.ts";

describe("branch names", () => {
  it("titles a prompt by its first non-empty line, kept short", () => {
    expect(titleFromPrompt("\n  Add history panel  \nKeep the last 50 results.")).toBe("Add history panel");
    expect(titleFromPrompt("x".repeat(200))).toHaveLength(120);
  });

  it("slugs a title for the branch, at most 40 characters, never empty", () => {
    expect(branchSlugFor("Add keyboard navigation to the history panel")).toBe("add-keyboard-navigation-to-the-history-p");
    expect(branchSlugFor("Résumé: café!")).toBe("resume-cafe");
    expect(branchSlugFor("!!!")).toBe("task");
    expect(slugify("Acme Corp", "org")).toBe("acme-corp");
  });

  it("names the branch the panel previews, with the task ID's part in front", () => {
    const taskId = taskIdSchema.parse("01a1f172-b165-70d1-9004-80ea83bcef62");
    expect(branchNameFor(taskId, "Add history panel")).toBe(`ostra/83bcef62-${branchSlugFor("Add history panel")}`);
  });
});
