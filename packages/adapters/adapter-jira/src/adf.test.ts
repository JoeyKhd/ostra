import { describe, expect, it } from "vitest";

import { adfToMarkdown, markdownToAdf, readAdf } from "./adf.ts";
import type { AdfMark, AdfNode } from "./adf.ts";

// ADF, Jira's rich text, both ways (research/trackers.md §2.4): what Jira's editor writes, read into
// markdown for the ticket's context, and ostra's markdown written as the ADF Jira takes.

const doc = (...content: AdfNode[]): unknown => ({ type: "doc", version: 1, content });
const text = (value: string, marks?: readonly AdfMark[]): AdfNode => (marks === undefined ? { type: "text", text: value } : { type: "text", text: value, marks });
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

describe("ADF to markdown", () => {
  it("reads headings, paragraphs, marks and hard breaks", () => {
    const read = adfToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("What")] },
        paragraph(
          text("Fix the "),
          text("banner", [{ type: "strong" }]),
          text(" and "),
          text("footer", [{ type: "em" }]),
          text(", not "),
          text("old", [{ type: "strike" }]),
          { type: "hardBreak" },
          text("run "),
          text("$(whoami)", [{ type: "code" }]),
        ),
      ),
    );
    expect(read).toBe("## What\n\nFix the **banner** and _footer_, not ~~old~~\nrun `$(whoami)`");
  });

  it("reads bullet, ordered, nested and task lists", () => {
    const item = (...content: AdfNode[]): AdfNode => ({ type: "listItem", content });
    const read = adfToMarkdown(
      doc(
        { type: "bulletList", content: [item(paragraph(text("one")), { type: "bulletList", content: [item(paragraph(text("nested")))] }), item(paragraph(text("two")))] },
        { type: "orderedList", attrs: { order: 3 }, content: [item(paragraph(text("third"))), item(paragraph(text("fourth")))] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("shipped")] }, { type: "taskItem", attrs: { state: "TODO" }, content: [text("to do")] }] },
      ),
    );
    expect(read).toBe("- one\n  - nested\n- two\n\n3. third\n4. fourth\n\n- [x] shipped\n- [ ] to do");
  });

  it("reads code blocks with their language, quotes, panels, rules and tables", () => {
    const cell = (type: "tableHeader" | "tableCell", value: string): AdfNode => ({ type, content: [paragraph(text(value))] });
    const read = adfToMarkdown(
      doc(
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = `b`;\nrm -rf /")] },
        { type: "blockquote", content: [paragraph(text("quoted")), paragraph(text("twice"))] },
        { type: "panel", attrs: { panelType: "warning" }, content: [paragraph(text("careful"))] },
        { type: "rule" },
        { type: "table", content: [{ type: "tableRow", content: [cell("tableHeader", "Name"), cell("tableHeader", "Value")] }, { type: "tableRow", content: [cell("tableCell", "a|b"), cell("tableCell", "1")] }] },
      ),
    );
    expect(read).toBe(["```ts\nconst a = `b`;\nrm -rf /\n```", "> quoted\n>\n> twice", "> careful", "---", "| Name | Value |\n| --- | --- |\n| a\\|b | 1 |"].join("\n\n"));
  });

  it("F-008/c6: reads links, a bare link as itself, mentions, emoji, dates, statuses and cards", () => {
    const read = adfToMarkdown(
      doc(
        paragraph(
          text("the spec", [{ type: "link", attrs: { href: "https://example.test/spec" } }]),
          text(" "),
          text("https://example.test/a", [{ type: "link", attrs: { href: "https://example.test/a" } }]),
          text(" "),
          { type: "mention", attrs: { id: "5b10ac8d82e05b22cc7d4ef5", text: "@Alex Kim" } },
          text(" "),
          { type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } },
          text(" "),
          { type: "date", attrs: { timestamp: "1795392000000" } },
          text(" "),
          { type: "status", attrs: { text: "IN PROGRESS", color: "blue" } },
          text(" "),
          { type: "inlineCard", attrs: { url: "https://github.com/ostra-test/test1/pull/7" } },
        ),
      ),
    );
    expect(read).toBe("[the spec](https://example.test/spec) https://example.test/a @Alex Kim 🎉 2026-11-23 IN PROGRESS https://github.com/ostra-test/test1/pull/7");
  });

  it("F-008/c6: reads an upload's media node as its file, an external image as itself, and an unknown upload as its name", () => {
    const read = readAdf(
      doc(
        paragraph(text("See:")),
        { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "e2b1-uuid", collection: "", alt: "mock.png" } }] },
        { type: "mediaGroup", content: [{ type: "media", attrs: { type: "file", id: "f3c2-uuid", collection: "", alt: "spec.docx" } }] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { type: "external", url: "https://example.test/x.png", alt: "outside" } }] },
        { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "gone", alt: "lost.png" } }] },
      ),
      {
        media: ({ alt }) =>
          alt === "mock.png" ? { url: "https://site.test/a/1", name: "mock.png", image: true } : alt === "spec.docx" ? { url: "https://site.test/a/2", name: "spec.docx", image: false } : null,
      },
    );
    expect(read.markdown).toBe("See:\n\n![mock.png](https://site.test/a/1)\n\n[spec.docx](https://site.test/a/2)\n\n![outside](https://example.test/x.png)\n\n[lost.png]");
    expect(read.files.map((file) => file.url)).toEqual(["https://site.test/a/1", "https://site.test/a/2"]);
  });

  it("F-008/c6: keeps the text of a node it doesn't know, a block or an inline one", () => {
    const read = adfToMarkdown(
      doc(
        { type: "someFutureBlock", content: [paragraph(text("inside a new block"))] },
        paragraph(text("before "), { type: "someFutureInline", content: [text("inline text")] }, text(" after")),
        { type: "extension", attrs: { extensionKey: "x" }, text: "an extension's text" },
      ),
    );
    expect(read).toBe("inside a new block\n\nbefore inline text after\n\nan extension's text");
  });

  it("reads anything that isn't a document as empty, and a plain string as itself", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({ nope: true })).toBe("");
    expect(adfToMarkdown("a v2 body")).toBe("a v2 body");
  });

  it("stops at a depth cap instead of recursing without end", () => {
    let node: AdfNode = paragraph(text("deep"));
    for (let level = 0; level < 500; level += 1) node = { type: "blockquote", content: [node] };
    expect(adfToMarkdown(doc(node))).toContain("deep");
  });
});

describe("markdown to ADF", () => {
  it("writes headings, paragraphs with breaks, and marks, with code sharing a text only with a link", () => {
    expect(markdownToAdf("## What\n\nFix **the** _banner_ ~~now~~\nrun `$(whoami)` [**docs**](https://example.test/d)")).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "What" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Fix " },
            { type: "text", text: "the", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "banner", marks: [{ type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "now", marks: [{ type: "strike" }] },
            { type: "hardBreak" },
            { type: "text", text: "run " },
            { type: "text", text: "$(whoami)", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.test/d" } }, { type: "strong" }] },
          ],
        },
      ],
    });
  });

  it("F-008/c6: writes nested and ordered lists, code blocks, quotes, rules and tables", () => {
    const written = markdownToAdf("- one\n  - nested\n- two\n\n3. third\n\n```sh\nrm -rf / && echo `x`\n```\n\n> quoted\n\n---\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(written.content.map((node) => node.type)).toEqual(["bulletList", "orderedList", "codeBlock", "blockquote", "rule", "table"]);
    expect(written.content[0]).toEqual({
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "nested" }] }] }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ],
    });
    expect(written.content[1]).toMatchObject({ type: "orderedList", attrs: { order: 3 } });
    // Code keeps its text exactly, shell characters and all.
    expect(written.content[2]).toEqual({ type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "rm -rf / && echo `x`" }] });
    expect(written.content[5]).toMatchObject({
      type: "table",
      content: [
        { type: "tableRow", content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
        { type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] }, { type: "tableCell" }] },
      ],
    });
  });

  it("F-008/c6: writes a mention by account ID, a bare URL as a link, and leaves `<sub>` as text", () => {
    expect(markdownToAdf("cc [~accountid:5b10ac8d82e05b22cc7d4ef5] <sub>see https://ostra.example.test/tasks/1.</sub>").content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "cc " },
        { type: "mention", attrs: { id: "5b10ac8d82e05b22cc7d4ef5" } },
        { type: "text", text: " <sub>see " },
        { type: "text", text: "https://ostra.example.test/tasks/1", marks: [{ type: "link", attrs: { href: "https://ostra.example.test/tasks/1" } }] },
        { type: "text", text: ".</sub>" },
      ],
    });
  });

  it("lifts an outside image into a media block, and writes one on the file host as a link to it", () => {
    const written = markdownToAdf("Before ![shot](https://example.test/x.png) after\n\n![progress.png](https://site.test/rest/api/3/attachment/content/7)", {
      isHostedFile: (url) => url.startsWith("https://site.test/"),
    });
    expect(written.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Before " }] },
      { type: "mediaSingle", attrs: { layout: "center" }, content: [{ type: "media", attrs: { type: "external", url: "https://example.test/x.png", alt: "shot" } }] },
      { type: "paragraph", content: [{ type: "text", text: " after" }] },
      { type: "paragraph", content: [{ type: "text", text: "progress.png", marks: [{ type: "link", attrs: { href: "https://site.test/rest/api/3/attachment/content/7" } }] }] },
    ]);
  });

  it("never makes a link of a script URL, and never writes an empty text", () => {
    const written = markdownToAdf("[click](javascript:alert(1)) ** ** `` a");
    const texts: string[] = [];
    const walk = (node: AdfNode): void => {
      if (node.type === "text") texts.push(node.text ?? "");
      expect(node.marks?.some((mark) => mark.type === "link") ?? false).toBe(false);
      for (const child of node.content ?? []) walk(child);
    };
    for (const node of written.content) walk(node);
    expect(texts.every((one) => one !== "")).toBe(true);
    expect(texts.join("")).toContain("[click]");
  });

  it("F-008/c6: round-trips the subset exactly: a heading, nested lists, a code block, a table, a link, a draft's description and the progress comment", () => {
    for (const markdown of [
      "## What\n\nThe banner shows the user's name.\n\n- [ ] One `$(whoami)` stays text",
      "**ostra is working on this.**\n\n[progress.png](https://example.test/p.png)\n\n<sub>ostra edits this comment as the task moves: https://ostra.example.test/tasks/1</sub>",
      "1. first\n2. second\n   - inner\n\n> a quote\n\n```ts\nconst x = 1;\n```",
      "- parent\n  - child\n    - grandchild\n- sibling",
      "| Step | Status |\n| --- | --- |\n| Started | In Progress |",
      "See [the spec](https://example.test/spec) and https://example.test/a",
      "ostra opened a PR",
    ]) {
      expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
    }
  });

  it("costs time linear in hostile input: unclosed delimiters, deep nesting and long runs", () => {
    const started = performance.now();
    markdownToAdf(`${"**_~~`[".repeat(20_000)}\n${"> ".repeat(5_000)}x\n${"- ".repeat(5_000)}y`);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
