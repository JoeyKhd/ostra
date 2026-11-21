import { remarkSteps } from "fumadocs-core/mdx-plugins/remark-steps";
import type { Root } from "mdast";

// The site's remark steps that decide a heading's anchor, apart from the others
// (`remark-plugins.ts`), so a check of a link's anchor runs exactly these (`heading-anchors.ts`).

/** Drops a page's leading `# Title`: the layout prints the title, from the front matter or this line. */
export const remarkDropTitle = () => (tree: Root) => {
  const index = tree.children.findIndex((node) => node.type !== "yaml" && node.type !== "html");
  const first = tree.children[index];
  if (first?.type === "heading" && first.depth === 1) {
    tree.children.splice(index, 1);
  }
};

/**
 * The steps that change a heading's anchor, in the order the site's pages run them, first of all
 * (`source.config.ts`): the leading title dropped, then the numbered steps. `remarkSteps` turns
 * `## 3. Connect GitHub` into a step and drops the number from its text, so its anchor is
 * `#connect-github`.
 */
export const headingRemarkPlugins = [remarkDropTitle, remarkSteps];
