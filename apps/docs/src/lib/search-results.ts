import type { SearchResultItem } from "fumadocs-core/search/client";

/** A row of the search dialog: a page, or a heading inside one (docs-search.md). */
export type SearchRow =
  | { readonly kind: "page"; readonly id: string; readonly url: string; readonly title: string; readonly snippet: string }
  | { readonly kind: "heading"; readonly id: string; readonly url: string; readonly title: string; readonly snippet: string; readonly mono: boolean };

/** The rows of one page, under its path line (`Runners › Pools and join tokens`). */
export type SearchGroup = { readonly key: string; readonly path: string; readonly rows: SearchRow[] };

/** Every heading of the site by its address, as written: the export's `api/search-headings`. */
export type HeadingTitles = Readonly<Record<string, string>>;

const SETTING = /^[A-Z][A-Z0-9_]+$/;

const pageOf = (url: string): string => url.split("#")[0] ?? url;

/** A window of the text around the first matched word, with an ellipsis at each cut end. */
export const snippetOf = (text: string, query: string): string => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const at = Math.max(0, ...words.map((word) => text.toLowerCase().indexOf(word)));
  const start = at < 60 ? 0 : text.lastIndexOf(" ", at - 30) + 1;
  const end = Math.min(text.length, at + 90);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
};

const titleMatches = (title: string, query: string): boolean =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .some((word) => title.toLowerCase().split(/[^a-z0-9_]+/).some((part) => part.startsWith(word)));

/**
 * A heading's text, for a text match whose heading the index didn't return: as written, from the
 * export's list of headings, and only without it the address's words.
 */
const headingTitleOf = (url: string, headings: HeadingTitles): string =>
  headings[url] ?? decodeURIComponent(url.split("#")[1] ?? "").replace(/-/g, " ");

/** Groups the index's results by page, in the order of each page's best hit (docs-search.md). */
export const groupResults = (items: readonly SearchResultItem[], query: string, headings: HeadingTitles): SearchGroup[] => {
  const groups = new Map<string, SearchGroup>();
  const short = query.trim().length <= 2;
  for (const item of items) {
    if ("type" in item && item.type === "table") {
      continue;
    }
    if (!("url" in item)) {
      continue;
    }
    const key = pageOf(item.url);
    let group = groups.get(key);
    if (group === undefined) {
      const crumbs = item.breadcrumbs ?? [];
      group = { key, path: crumbs.join(" › "), rows: [] };
      groups.set(key, group);
    }
    const content = item.content;
    if (item.type === "page") {
      group = { ...group, path: [...(item.breadcrumbs ?? []), content].join(" › ") };
      groups.set(key, group);
      if (titleMatches(content, query)) {
        group.rows.unshift({ kind: "page", id: item.id, url: item.url, title: content, snippet: "" });
      }
    } else if (item.type === "heading") {
      if (!short || SETTING.test(content) || titleMatches(content, query)) {
        group.rows.push({ kind: "heading", id: item.id, url: item.url, title: content, snippet: "", mono: SETTING.test(content) });
      }
    } else if (!short) {
      const owner = group.rows.find((row) => row.url === item.url);
      const index = owner === undefined ? -1 : group.rows.indexOf(owner);
      if (owner?.snippet === "") {
        group.rows[index] = { ...owner, snippet: snippetOf(content, query) };
      } else if (owner === undefined && item.url === key) {
        // The page's own text: its description under the page row, or a row of its own.
        const pageRow = group.rows.find((row) => row.kind === "page");
        if (pageRow?.snippet === "") {
          group.rows[group.rows.indexOf(pageRow)] = { ...pageRow, snippet: content };
        }
      } else if (owner === undefined) {
        const title = headingTitleOf(item.url, headings);
        group.rows.push({ kind: "heading", id: item.id, url: item.url, title, snippet: snippetOf(content, query), mono: SETTING.test(title) });
      }
    }
  }
  return [...groups.values()].filter((group) => group.rows.length > 0).slice(0, 8);
};
