import { getTableOfContents } from "fumadocs-core/content/toc";
import type { Root, RootContent } from "mdast";

import { headingRemarkPlugins } from "./heading-plugins.ts";

/** A page's front matter, which Fumadocs reads apart from the page's Markdown. */
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/** The nodes with each JSX element `remarkSteps` added replaced by what it wraps. */
const unwrap = (nodes: readonly RootContent[]): RootContent[] =>
  nodes.flatMap((node): readonly RootContent[] => {
    const type: string = node.type;
    return type === "mdxJsxFlowElement" && "children" in node ? unwrap(node.children) : [node];
  });

/**
 * Unwraps the step `div`s `remarkSteps` puts around a page's steps, which the table of contents'
 * plain Markdown can't print. The headings stay as the steps left them, so their anchors don't change.
 */
const remarkUnwrapSteps = () => (tree: Root) => {
  tree.children = unwrap(tree.children);
};

/**
 * The anchors of a page's headings as the site renders them, without the `#`: the site's steps that
 * decide a heading's anchor (`headingRemarkPlugins`), then Fumadocs' own heading slugs. A link into
 * the docs with an anchor is checked against these, never against a slug written again by hand.
 */
export const headingAnchors = async (source: string): Promise<readonly string[]> => {
  const toc = await getTableOfContents(source.replace(FRONT_MATTER, ""), [...headingRemarkPlugins, remarkUnwrapSteps]);
  return toc.map((item) => item.url.replace(/^#/, ""));
};
