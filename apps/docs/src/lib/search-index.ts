import type { StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";

import { loadConfigurationReference } from "./configuration-source";
import { settingsOf } from "./configuration-reference";
import { flatPages } from "./navigation";
import { plainStructuredData } from "./search-text";
import type { DocsPage } from "./source";

/** The reference's rows as headings, so a setting's name finds its row (docs-search.md). */
const settingsData = async (): Promise<StructuredData> => {
  const rows = settingsOf(await loadConfigurationReference());
  return {
    headings: rows.map((row) => ({ id: row.name, content: row.name })),
    contents: rows.map((row) => ({ heading: row.name, content: row.description })),
  };
};

/** A compiled page's structured data; a page whose records depend on props has none to index. */
const compiledDataOf = (value: StructuredData | (() => unknown) | undefined): StructuredData =>
  value === undefined || typeof value === "function" ? { headings: [], contents: [] } : value;

/** What the index holds of a page: its headings and text records, in plain text. */
export const structuredDataOf = async (page: DocsPage): Promise<StructuredData> =>
  plainStructuredData(page.slugs.join("/") === "reference/configuration" ? await settingsData() : compiledDataOf(page.data.structuredData));

/** The section a page sits in, the first part of its result's path (`Runners › Pools and join tokens`). */
export const sectionTitleOf = (url: string): string => flatPages().find((entry) => entry.page.url === url)?.section.title ?? "Docs";
