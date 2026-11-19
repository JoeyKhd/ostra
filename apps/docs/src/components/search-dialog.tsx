"use client";

import { useHighlightQuery, useStaticSearch } from "fumadocs-core/search/client";
import type { SearchResultItem } from "fumadocs-core/search/client";
import { CircleAlert, CornerDownLeft, FileText, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { basePath, startHere } from "@/lib/site";

type Row =
  | { readonly kind: "page"; readonly id: string; readonly url: string; readonly title: string; readonly snippet: string }
  | { readonly kind: "heading"; readonly id: string; readonly url: string; readonly title: string; readonly snippet: string; readonly mono: boolean };

type Group = { readonly key: string; readonly path: string; readonly rows: Row[] };

const SETTING = /^[A-Z][A-Z0-9_]+$/;

const pageOf = (url: string): string => url.split("#")[0] ?? url;

/** A window of the text around the first matched word, with an ellipsis at each cut end. */
const snippetOf = (text: string, query: string): string => {
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

/** Groups the index's results by page, in the order of each page's best hit (docs-search.md). */
const groupResults = (items: readonly SearchResultItem[], query: string): Group[] => {
  const groups = new Map<string, Group>();
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
        const title = decodeURIComponent(item.url.split("#")[1] ?? "").replace(/-/g, " ");
        group.rows.push({ kind: "heading", id: item.id, url: item.url, title, snippet: snippetOf(content, query), mono: SETTING.test(title) });
      }
    }
  }
  return [...groups.values()].filter((group) => group.rows.length > 0).slice(0, 8);
};

const EmptyState = ({ query }: { readonly query: string }) => (
  <div className="search-empty">
    <span className="search-empty-art" aria-hidden="true">
      <img src={`${basePath}/deep-water.webp`} alt="" />
    </span>
    <p className="search-empty-title">No results for “{query}”</p>
    <p className="search-empty-text">Try a setting&apos;s name, a command or a page&apos;s title.</p>
    <a className="teal-link" href={`${basePath}/docs/start/what-ostra-is/`}>
      Browse the sections →
    </a>
  </div>
);

/**
 * The docs search (docs-search.md): the static index, searched in the browser, with results grouped
 * by page. Fumadocs' provider opens it from the header, ⌘K, Ctrl+K or `/`.
 */
export const SearchDialog = ({ open, onOpenChange }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) => {
  const { search, onSearchChange, isLoading, data, error } = useStaticSearch({ from: `${basePath}/api/search`, delayMs: 80 });
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const router = useRouter();
  const listId = useId();
  const highlight = useHighlightQuery(search);

  const query = search.trim();
  const groups = useMemo(() => (query === "" || data === undefined ? [] : groupResults(data.items, query)), [data, query]);
  const rows: Row[] =
    query === ""
      ? startHere.map((page) => ({ kind: "page", id: `start-${page.url}`, url: page.url, title: page.title, snippet: "" }))
      : groups.flatMap((group) => group.rows);
  const count = rows.length;

  useEffect(() => {
    setSelected(0);
  }, [data, query]);
  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      input.current?.focus();
      input.current?.select();
    } else if (opener.current instanceof HTMLElement) {
      opener.current.focus();
    }
  }, [open]);
  useEffect(() => {
    document.getElementById(`${listId}-${String(selected)}`)?.scrollIntoView({ block: "nearest" });
  }, [selected, listId]);

  if (!open) {
    return null;
  }
  const close = () => {
    onOpenChange(false);
  };
  const choose = (row: Row, newTab: boolean) => {
    if (newTab) {
      window.open(`${basePath}${row.url.replace(/(#|$)/, "/$1")}`, "_blank", "noopener");
      return;
    }
    close();
    router.push(row.url);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (count > 0) {
        setSelected((value) => (value + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
      }
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSelected(event.key === "Home" ? 0 : Math.max(0, count - 1));
    } else if (event.key === "Enter") {
      const row = rows[selected];
      if (row !== undefined) {
        event.preventDefault();
        choose(row, event.metaKey || event.ctrlKey);
      }
    } else if (event.key === "Tab") {
      // Focus stays in the dialog: its input is the one stop.
      event.preventDefault();
    }
  };

  let index = -1;
  const renderRow = (row: Row) => {
    index += 1;
    const position = index;
    const isSelected = position === selected;
    return (
      <li
        key={row.id}
        id={`${listId}-${String(position)}`}
        role="option"
        aria-selected={isSelected}
        className={`search-row is-${row.kind}${row.snippet === "" ? "" : " has-snippet"}${isSelected ? " is-selected" : ""}`}
        onMouseMove={() => {
          setSelected(position);
        }}
        onClick={(event) => {
          choose(row, event.metaKey || event.ctrlKey);
        }}
      >
        <span className="search-row-icon" aria-hidden="true">
          {row.kind === "page" ? <FileText size={16} strokeWidth={1.75} /> : "#"}
        </span>
        <span className="search-row-text">
          <span className={row.kind === "heading" && row.mono ? "search-row-title is-mono" : "search-row-title"}>{row.title}</span>
          {row.snippet === "" ? null : <span className="search-row-snippet">{row.snippet}</span>}
        </span>
        {isSelected ? (
          <kbd className="search-enter" aria-hidden="true">
            <CornerDownLeft size={13} strokeWidth={1.75} />
          </kbd>
        ) : null}
      </li>
    );
  };

  const status = query === "" ? "" : `${String(count)} ${count === 1 ? "result" : "results"}`;
  const noResults = query !== "" && data !== undefined && !isLoading && count === 0 && error === undefined;
  return (
    <div className="search-root">
      <div className="search-overlay" aria-hidden="true" onClick={close} />
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search the docs" onKeyDown={onKeyDown}>
        <div className="search-input-row">
          <Search size={18} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={input}
            role="combobox"
            aria-expanded={count > 0}
            aria-controls={listId}
            aria-activedescendant={count > 0 ? `${listId}-${String(selected)}` : undefined}
            aria-autocomplete="list"
            placeholder="Search the docs"
            value={search}
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
          />
          <button type="button" className="search-esc" onClick={close}>
            <span className="desktop-only">esc</span>
            <span className="phone-only">Cancel</span>
          </button>
        </div>
        {/* Keyed by the results, so the highlight's ref runs again on the new rows. */}
        <div className="search-results" ref={highlight} key={`${query}-${String(data?.items.length ?? 0)}`}>
          {error !== undefined ? (
            <p className="search-error">
              <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Search couldn&apos;t load. Check your connection and try again.</span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  onSearchChange(`${search} `);
                  onSearchChange(search);
                }}
              >
                Try again
              </button>
            </p>
          ) : noResults ? (
            <EmptyState query={query} />
          ) : query !== "" && data === undefined ? (
            <div className="search-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <ul id={listId} role="listbox" aria-label="Results" className="search-list">
              {query === "" ? (
                <li role="presentation" className="search-group">
                  <p className="search-start-label">Start here</p>
                  <ul role="group" aria-label="Start here">
                    {rows.map(renderRow)}
                  </ul>
                </li>
              ) : (
                groups.map((group) => (
                  <li role="presentation" key={group.key} className="search-group">
                    <p className="search-path" aria-hidden="true">
                      <FileText size={15} strokeWidth={1.75} />
                      {group.path}
                    </p>
                    <ul role="group" aria-label={group.path}>
                      {group.rows.map(renderRow)}
                    </ul>
                  </li>
                ))
              )}
            </ul>
          )}
        </div>
        <div className="search-footer">
          <span className="search-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd> Move <kbd>↵</kbd> Open <kbd>esc</kbd> Close
          </span>
          <span className="search-count">{query === "" ? "searched in your browser" : `${status} · searched in your browser`}</span>
          <span className="sr-only" aria-live="polite">
            {noResults ? `No results for ${query}` : status}
          </span>
        </div>
      </div>
    </div>
  );
};
