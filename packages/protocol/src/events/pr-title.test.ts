import { describe, expect, it } from "vitest";

import { repoIdSchema } from "../ids.ts";
import { taskEventSchema } from "./agent-events.ts";
import { cleanPrTitle, PR_TITLE_MAX_CHARS, prTitleSchema } from "./pr-title.ts";

describe("an agent's PR title (F-030/c2)", () => {
  it("F-030/c2: a title with newlines or control characters, or one too long, is cleaned up to one line", () => {
    // A wrapped line is joined, as git's subject joins its first paragraph; a second paragraph is left out.
    expect(cleanPrTitle("Round percent mode\nhalf up")).toBe("Round percent mode half up");
    expect(cleanPrTitle("  Add an essay about Lebanon\r\n\r\nIt covers its history and culture.\n")).toBe("Add an essay about Lebanon");
    expect(cleanPrTitle("\n\n  \nAdd ESSAY-lebanon.md")).toBe("Add ESSAY-lebanon.md");
    // Control characters and the ones that reorder or hide text are gone; tabs are spaces.
    expect(cleanPrTitle("Add\tthe\u0007 history\u001b[31m panel\u0000")).toBe("Add the history[31m panel");
    expect(cleanPrTitle("Fix \u202egnp.exe\u202c the \u200bparser")).toBe("Fix gnp.exe the parser");
    // A gitmoji, a joined emoji and other scripts stay as they are.
    expect(cleanPrTitle("✨ add the history panel 🧑\u200d💻")).toBe("✨ add the history panel 🧑\u200d💻");
    expect(cleanPrTitle("feat(calc): أضف السجل")).toBe("feat(calc): أضف السجل");
    // Too long: cut at a word, with an ellipsis, to the cap.
    const long = `Add ${"history ".repeat(30)}panel`;
    const cut = cleanPrTitle(long);
    expect(Array.from(cut).length).toBeLessThanOrEqual(PR_TITLE_MAX_CHARS);
    expect(cut.endsWith("history…")).toBe(true);
    expect(cleanPrTitle("x".repeat(300))).toBe(`${"x".repeat(PR_TITLE_MAX_CHARS - 1)}…`);
    // Cleaning a clean title changes nothing, so each boundary may read it again.
    for (const title of ["Add ESSAY-lebanon.md", cut, "✨ add the history panel 🧑\u200d💻"]) {
      expect(cleanPrTitle(title)).toBe(title);
    }
  });

  it("F-030/c2: refuses a title that says nothing once it's one line, and reads pr.text_set's title through it", () => {
    expect(prTitleSchema.safeParse("  \n\u0007\t ").success).toBe(false);
    expect(prTitleSchema.safeParse("").success).toBe(false);
    expect(prTitleSchema.parse("Add a short\nCONTRIBUTING.md")).toBe("Add a short CONTRIBUTING.md");
    const event = taskEventSchema.parse({ kind: "pr.text_set", repoId: repoIdSchema.parse("repo-1"), title: "Add the essay\u0007\n\nBody text", body: "## What\n" });
    expect(event).toEqual({ kind: "pr.text_set", repoId: "repo-1", title: "Add the essay", body: "## What\n" });
    expect(taskEventSchema.safeParse({ kind: "pr.text_set", repoId: "repo-1", title: "\u0000", body: "" }).success).toBe(false);
  });
});
