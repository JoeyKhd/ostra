import { structuredDataOf } from "@/lib/search-index";
import { headingTitlesOf } from "@/lib/search-text";
import { source } from "@/lib/source";

// Every heading of the site by its address, as written, exported as a file beside the index. A text
// match under a heading the query doesn't match shows that heading's row, and the index's results
// carry only the heading's address (docs-search.md).
export const revalidate = false;

export const GET = async (): Promise<Response> => {
  const titles = await Promise.all(source.getPages().map(async (page) => headingTitlesOf(page.url, await structuredDataOf(page))));
  return Response.json(Object.assign({}, ...titles));
};
