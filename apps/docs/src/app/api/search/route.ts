import { createFromSource } from "fumadocs-core/search/server";
import type { StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";

import { loadConfigurationReference } from "@/lib/configuration-source";
import { settingsOf } from "@/lib/configuration-reference";
import { flatPages } from "@/lib/navigation";
import { source } from "@/lib/source";

// The search index, built with the export and served as a file (ADR 0063: no hosted search). The
// browser fetches it once and searches it locally.
export const revalidate = false;

const plain = (markdown: string): string => markdown.replace(/[`*]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

/** The reference's rows as headings, so a setting's name finds its row (docs-search.md). */
const settingsData = async (): Promise<StructuredData> => {
  const rows = settingsOf(await loadConfigurationReference());
  return {
    headings: rows.map((row) => ({ id: row.name, content: row.name })),
    contents: rows.map((row) => ({ heading: row.name, content: plain(row.description) })),
  };
};

/** A compiled page's structured data; a page whose records depend on props has none to index. */
const structuredDataOf = (value: StructuredData | (() => unknown) | undefined): StructuredData =>
  value === undefined || typeof value === "function" ? { headings: [], contents: [] } : value;

const sectionTitle = (url: string): string => flatPages().find((entry) => entry.page.url === url)?.section.title ?? "Docs";

export const { staticGET: GET } = createFromSource(source, {
  buildIndex: async (page) => ({
    id: page.url,
    url: page.url,
    title: page.data.title ?? "",
    description: page.data.description ?? "",
    breadcrumbs: [sectionTitle(page.url)],
    structuredData:
      page.slugs.join("/") === "reference/configuration" ? await settingsData() : structuredDataOf(page.data.structuredData),
  }),
});
