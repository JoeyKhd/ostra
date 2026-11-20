import { createFromSource } from "fumadocs-core/search/server";

import { sectionTitleOf, structuredDataOf } from "@/lib/search-index";
import { plainText } from "@/lib/search-text";
import { source } from "@/lib/source";

// The search index, built with the export and served as a file (ADR 0063: no hosted search). The
// browser fetches it once and searches it locally. Its text is plain, not Markdown (search-text.ts).
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, {
  buildIndex: async (page) => ({
    id: page.url,
    url: page.url,
    title: page.data.title ?? "",
    description: plainText(page.data.description ?? ""),
    breadcrumbs: [sectionTitleOf(page.url)],
    structuredData: await structuredDataOf(page),
  }),
});
