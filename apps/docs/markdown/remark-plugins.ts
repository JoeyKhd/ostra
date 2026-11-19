// The site's own Markdown steps, for its MDX pages and the Markdown files read from `docs/`. Each
// keeps to plain Markdown syntax, so a page reads the same on GitHub (ADR 0063).
import type { Blockquote, Code, Heading, Paragraph, Root, RootContent } from "mdast";

/** The callouts, from GitHub's alert syntax: `> [!NOTE]`, `> [!WARNING]`, `> [!CAUTION]`. */
export type CalloutKind = "note" | "warning" | "not-isolated";

const alertKinds: Readonly<Record<string, CalloutKind>> = {
  NOTE: "note",
  TIP: "note",
  IMPORTANT: "note",
  WARNING: "warning",
  CAUTION: "not-isolated",
};

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/;

const withProperties = (node: Blockquote | Code | Heading, properties: Record<string, string>): void => {
  const data = node.data ?? {};
  node.data = { ...data, hProperties: { ...data.hProperties, ...properties } };
};

const alertOf = (node: Blockquote): CalloutKind | null => {
  const first = node.children[0];
  if (first?.type !== "paragraph") {
    return null;
  }
  const text = first.children[0];
  if (text?.type !== "text") {
    return null;
  }
  const match = ALERT.exec(text.value);
  const kind = match?.[1] === undefined ? undefined : alertKinds[match[1]];
  if (match === null || kind === undefined) {
    return null;
  }
  text.value = text.value.slice(match[0].length).replace(/^\n/, "");
  if (text.value === "") {
    (first satisfies Paragraph).children.shift();
    const next = first.children[0];
    if (next?.type === "break") {
      first.children.shift();
    }
  }
  return kind;
};

const walk = (nodes: readonly RootContent[], visit: (node: RootContent) => void): void => {
  for (const node of nodes) {
    visit(node);
    if ("children" in node) {
      walk(node.children, visit);
    }
  }
};

/** Marks a blockquote that starts with an alert as a callout (`data-callout`). */
export const remarkCallouts = () => (tree: Root) => {
  walk(tree.children, (node) => {
    if (node.type === "blockquote") {
      const kind = alertOf(node);
      if (kind !== null) {
        withProperties(node, { "data-callout": kind });
      }
    }
  });
};

/**
 * Keeps a code block's language and its `run` marker (` ```sh run `) on the element, for the code
 * block component and ticket 22's command check, which reads the same meta.
 */
export const remarkCodeMeta = () => (tree: Root) => {
  walk(tree.children, (node) => {
    if (node.type === "code") {
      const meta = (node.meta ?? "").split(/\s+/);
      withProperties(node, {
        "data-lang": node.lang ?? "text",
        ...(meta.includes("run") ? { "data-run": "true" } : {}),
      });
    }
  });
};

/** Drops a page's leading `# Title`: the layout prints the title, from the front matter or this line. */
export const remarkDropTitle = () => (tree: Root) => {
  const index = tree.children.findIndex((node) => node.type !== "yaml" && node.type !== "html");
  const first = tree.children[index];
  if (first?.type === "heading" && first.depth === 1) {
    tree.children.splice(index, 1);
  }
};

/** A Markdown file's title: its first `# ` line. */
export const titleOf = (source: string): string | undefined => /^# (.+)$/m.exec(source)?.[1]?.trim();
