import { describe, expect, it } from "vitest";

import { BODY_MAX_CHARS, SUBJECT_MAX_CHARS, markdownLine, renderTrackerComment, safeLink, usableMentions } from "./comment-text.ts";
import type { TrackerCommentInput } from "./comment-text.ts";

// The ticket comment's pure renderer (ticket 11, F-036): what lands on a ticket is decided here.

const input: TrackerCommentInput = {
  title: "An approval needs you",
  subject: "Add CONTRIBUTING.md",
  body: "The agent asks to edit a file.",
  url: "https://ostra.example/t/task-1?item=1",
  state: "open",
  mentions: [],
};

describe("the ticket comment's text", () => {
  it("F-036: is the moment, the task's title in quotes, the line about it and the link", () => {
    expect(renderTrackerComment(input)).toBe(
      [
        '**An approval needs you** on "Add CONTRIBUTING.md"',
        "",
        "The agent asks to edit a file.",
        "",
        "[Open the task](https://ostra.example/t/task-1?item=1)",
      ].join("\n"),
    );
  });

  it("F-036: puts the mentions first, so the tracker notifies them", () => {
    const text = renderTrackerComment({ ...input, mentions: ["@ada", "[~accountid:7]"] });
    expect(text?.startsWith("@ada [~accountid:7]\n\n**An approval needs you**")).toBe(true);
  });

  it("F-036: says an answered or dismissed moment is, and drops a line that only repeats the title", () => {
    expect(renderTrackerComment({ ...input, state: "answered", body: input.title })).toBe(
      ['**An approval needs you (answered)** on "Add CONTRIBUTING.md"', "", "[Open the task](https://ostra.example/t/task-1?item=1)"].join("\n"),
    );
    expect(renderTrackerComment({ ...input, state: "dismissed" })).toContain("(dismissed)");
  });

  it("F-036: refuses a link that isn't a web address, and encodes brackets in one that is", () => {
    expect(renderTrackerComment({ ...input, url: "javascript:alert(1)" })).toBeUndefined();
    expect(renderTrackerComment({ ...input, url: "not a url" })).toBeUndefined();
    expect(safeLink("https://ostra.example/a(b)c")).toBe("https://ostra.example/a%28b%29c");
    expect(safeLink("https://ostra.example/a b")).toBe("https://ostra.example/a%20b");
    expect(safeLink("file:///etc/passwd")).toBeUndefined();
  });

  it("F-036: escapes markdown, flattens lines and cuts what isn't ostra's own words", () => {
    expect(markdownLine("a *b* _c_ `d` [e](f) <g> #h ~i~ | @j !k &l", 200)).toBe(
      String.raw`a \*b\* \_c\_ \`d\` \[e\](f) \<g\> \#h \~i\~ \| \@j \!k \&l`,
    );
    expect(markdownLine("line one\n\n  line\ttwo\r\nthree", 200)).toBe("line one line two three");
    expect(markdownLine("see https://x.example", 200)).toBe(String.raw`see https:\/\/x.example`);
    expect(markdownLine("x".repeat(SUBJECT_MAX_CHARS + 50), SUBJECT_MAX_CHARS)).toBe(`${"x".repeat(SUBJECT_MAX_CHARS - 1)}…`);
    // A cut never splits a character.
    expect(Array.from(markdownLine("🙂".repeat(BODY_MAX_CHARS + 5), BODY_MAX_CHARS))).toHaveLength(BODY_MAX_CHARS);
  });

  it("F-036: keeps only mentions a tracker could have made: not empty, one line, each once", () => {
    expect(usableMentions(["@ada", null, "  ", "@ada", "[~accountid:7]", "@a\nb", "@" + "x".repeat(300)])).toEqual(["@ada", "[~accountid:7]"]);
  });
});
