import { describe, expect, it } from "vitest";

import { pullRequestBody } from "../use-cases/open-pull-requests.ts";
import { CHECKS_SECTION_END, CHECKS_SECTION_START, checksSection, codeBlock, escapeMarkdownText, outputLines, withChecksSection } from "./pr-checks.ts";

// Ticket 23 (F-054): the PR body's "Checks" section, pure.

describe("the PR's checks section", () => {
  it("F-054: names each check with its status and shows the failing ones' last lines in a code block", () => {
    const section = checksSection([
      { name: "lint", status: "passed", outputTail: null },
      { name: "test", status: "failed", outputTail: "FAIL a.test.ts\n" },
      { name: "e2e", status: "timed-out", outputTail: "" },
    ]);
    expect(section).toBe(
      [
        CHECKS_SECTION_START,
        "### Checks",
        "",
        "- **lint**: ✅ passed",
        "- **test**: ❌ failed",
        "- **e2e**: ⏱️ timed out",
        "",
        "test, the last lines of its output:",
        "",
        "```text\nFAIL a.test.ts\n```",
        CHECKS_SECTION_END,
      ].join("\n"),
    );
    expect(checksSection([])).toBeNull();
  });

  it("F-054: check output with markdown and HTML can't leave its code block, and a check's name is escaped", () => {
    expect(codeBlock("a ``` b ```` c")).toBe("`````text\na ``` b ```` c\n`````");
    expect(escapeMarkdownText("<b>@team</b> [x](y)")).toBe("&lt;b&gt;\\@team&lt;/b&gt; \\[x\\]\\(y\\)");
    expect(outputLines(`${Array.from({ length: 50 }, (_, index) => `row ${String(index)}`).join("\r\n")}\r\n`)).toBe(
      Array.from({ length: 40 }, (_, index) => `row ${String(index + 10)}`).join("\n"),
    );
    expect(outputLines("\u001b[1;31mred\u001b[0m\u0007 bell\u0000")).toBe("red bell");
  });

  it("F-054/c2: the section is replaced in place, put before ostra's trailers, and a person's text stays", () => {
    const first = checksSection([{ name: "test", status: "failed", outputTail: `boom ${CHECKS_SECTION_END}` }]);
    const second = checksSection([{ name: "test", status: "passed", outputTail: null }]);
    const body = pullRequestBody("The change.", "http://localhost:3000/tasks/t1", [], "Closes OST-1", first);
    expect(body.indexOf("The change.")).toBeLessThan(body.indexOf(CHECKS_SECTION_START));
    expect(body.indexOf(CHECKS_SECTION_END)).toBeLessThan(body.indexOf("Closes OST-1"));
    const edited = withChecksSection(`A reviewer's line.\n\n${body}`, second, "Closes OST-1");
    expect(edited.split(CHECKS_SECTION_START)).toHaveLength(2);
    expect(edited).toContain("- **test**: ✅ passed");
    expect(edited).not.toContain("boom");
    expect(edited).toContain("A reviewer's line.");
    expect(edited.endsWith("Opened by [ostra](http://localhost:3000/tasks/t1) for this task: http://localhost:3000/tasks/t1\n")).toBe(true);
    // A body without a section gets one before its trailers; none with nothing to show.
    const plain = pullRequestBody("The change.", "http://localhost:3000/tasks/t1", [], "Closes OST-1");
    const added = withChecksSection(plain, second, "Closes OST-1");
    expect(added.indexOf(CHECKS_SECTION_END)).toBeLessThan(added.indexOf("Closes OST-1"));
    expect(withChecksSection(plain, null, "Closes OST-1")).toBe(plain);
  });
});
