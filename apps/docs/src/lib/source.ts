import { docs, repoDocs } from "fumadocs-mdx:collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

/**
 * The guides read from `docs/`, placed in the Contributing section: `docs/development.md` is
 * `contributing/development`, `docs/agents/domain.md` is `contributing/agents-domain`.
 */
const repoSource = (() => {
  const source = toFumadocsSource(repoDocs, []);
  return {
    ...source,
    files: source.files.map((file) => ({ ...file, path: `contributing/${file.path.replaceAll("/", "-")}` })),
  };
})();

export const source = loader({
  baseUrl: "/docs",
  source: { docs: docs.toFumadocsSource(), repo: repoSource },
});

export type DocsPage = ReturnType<typeof source.getPages>[number];

/** The page's file in the repo, for "Edit on GitHub": `content/` for the site's pages, `docs/` for the others. */
export const repoPathOf = (page: DocsPage): string => {
  if (page.slugs.join("/") === "reference/configuration") {
    return "docs/configuration.md";
  }
  return page.type === "repo"
    ? `docs/${page.path.replace(/^contributing\//, "").replace(/^agents-/, "agents/")}`
    : `apps/docs/content/${page.path}`;
};
