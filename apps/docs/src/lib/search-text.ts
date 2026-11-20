// The search index's text (docs-search.md): Fumadocs records each paragraph, list, table and heading
// as a slice of its page's Markdown, so a snippet would show `**New token**` and backticks as typed.
// The index is given plain text instead, read with a real Markdown parser, and the heading of every
// text record is kept as written, for the dialog's heading rows.
import type { StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** GitHub's alert marker at the start of a callout (`> [!NOTE]`), which the site draws as a label. */
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

/** The words of a node, its blocks, list items, table cells and lines kept apart by a space. */
const textOf = (node: Nodes): string => {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      return node.value;
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "break":
    case "thematicBreak":
    case "html":
    case "definition":
    case "footnoteReference":
    case "yaml":
    case "mdxjsEsm":
    case "mdxFlowExpression":
    case "mdxTextExpression":
      return " ";
    case "root":
    case "paragraph":
    case "heading":
    case "blockquote":
    case "list":
    case "listItem":
    case "table":
    case "tableRow":
    case "tableCell":
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
    case "footnoteDefinition":
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement": {
      const inline = ["paragraph", "heading", "tableCell", "emphasis", "strong", "delete", "link", "linkReference", "mdxJsxTextElement"].includes(node.type);
      return node.children.map((child) => textOf(child)).join(inline ? "" : " ");
    }
    default:
      return node satisfies never;
  }
};

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A record's Markdown as the words a reader sees: no emphasis marks, backticks, link targets or table pipes. */
export const plainText = (markdown: string): string => {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return squash(textOf(tree)).replace(ALERT, "");
};

/**
 * A heading's Markdown as written: read as a heading, so a step's `6. Connect a runner` keeps its
 * number instead of becoming a list.
 */
export const plainHeading = (markdown: string): string => plainText(`# ${squash(markdown)}`);

/** A page's structured data with every heading and text record in plain text. */
export const plainStructuredData = (data: StructuredData): StructuredData => ({
  headings: data.headings.map((heading) => ({ ...heading, content: plainHeading(heading.content) })),
  contents: data.contents.map((record) => ({ ...record, content: plainText(record.content) })).filter((record) => record.content !== ""),
});

/** Each heading of a page by its address (`/docs/install/setup#connect-a-runner`), as written. */
export const headingTitlesOf = (url: string, data: StructuredData): Record<string, string> =>
  Object.fromEntries(data.headings.map((heading) => [`${url}#${heading.id}`, plainHeading(heading.content)]));
