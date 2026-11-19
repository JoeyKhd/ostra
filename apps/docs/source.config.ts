import path from "node:path";

import { remarkSteps } from "fumadocs-core/mdx-plugins/remark-steps";
import { pageSchema } from "fumadocs-core/source/schema";
import { defineCollections, defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

import { remarkCallouts, remarkCodeMeta, remarkDropTitle, titleOf } from "./markdown/remark-plugins.ts";

/** The site's own pages: `content/`, one folder per section, in `content/meta.json`'s order. */
export const docs = defineDocs({
  dir: "content",
  // `summary`: a guide's own first sentence, which the landing's 30-minute path shows.
  docs: { schema: pageSchema.extend({ summary: z.string().optional() }) },
});

/**
 * The guides a contributor reads in the repo (ADR 0063: `docs/` stays the one source). Read as files
 * at build time, never copied; their title is their `# ` line. `docs/configuration.md` belongs to
 * the configuration reference, which renders it itself.
 */
export const repoDocs = defineCollections({
  type: "doc",
  dir: "../../docs",
  files: ["development.md", "agents/*.md"],
  schema: (context) =>
    z.object({
      title: z.string().default(titleOf(context.source) ?? path.basename(context.path, ".md")),
      description: z.string().optional(),
    }),
});

export default defineConfig({
  mdxOptions: {
    // Code is drawn in the brand's mono, in one colour, as the targets do: no syntax theme.
    rehypeCodeOptions: false,
    remarkPlugins: (defaults) => [remarkDropTitle, remarkSteps, remarkCallouts, remarkCodeMeta, ...defaults],
  },
});
