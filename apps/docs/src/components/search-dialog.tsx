"use client";

import { useHighlightQuery, useStaticSearch } from "fumadocs-core/search/client";
import { CircleAlert, CornerDownLeft, FileText, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { z } from "zod";

import { groupResults } from "@/lib/search-results";
import type { HeadingTitles, SearchRow } from "@/lib/search-results";
import { basePath, startHere } from "@/lib/site";

// The headings file is ostra's own format, so the schema rejects anything else.
const headingTitlesSchema = z.record(z.string(), z.string());

type Row = SearchRow;

/** The export's headings, fetched once per visit beside the index (search-text.ts). */
let headingsRequest: Promise<HeadingTitles> | undefined;
const loadHeadings = (): Promise<HeadingTitles> => {
  headingsRequest ??= fetch(`${basePath}/api/search-headings`)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`api/search-headings answered ${String(response.status)}`);
      }
      return headingTitlesSchema.parse(await response.json());
    })
    .catch((error: unknown) => {
      headingsRequest = undefined;
      throw error;
    });
  return headingsRequest;
};

type HeadingsState = { readonly headings: HeadingTitles | undefined; readonly failed: boolean };

/** The headings file, once the dialog has opened: `undefined` while it loads. */
const useHeadings = (open: boolean, attempt: number): HeadingsState => {
  const [state, setState] = useState<HeadingsState>({ headings: undefined, failed: false });
  useEffect(() => {
    if (!open) {
      return;
    }
    let live = true;
    loadHeadings().then(
      (headings) => {
        if (live) {
          setState({ headings, failed: false });
        }
      },
      () => {
        if (live) {
          setState({ headings: undefined, failed: true });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [open, attempt]);
  return state;
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
  const [attempt, setAttempt] = useState(0);
  const { headings, failed } = useHeadings(open, attempt);

  const query = search.trim();
  const groups = useMemo(
    () => (query === "" || data === undefined || headings === undefined ? [] : groupResults(data.items, query, headings)),
    [data, query, headings],
  );
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
  const loadFailed = error !== undefined || failed;
  const loaded = data !== undefined && headings !== undefined;
  const noResults = query !== "" && loaded && !isLoading && count === 0 && !loadFailed;
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
          {loadFailed ? (
            <p className="search-error">
              <CircleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>Search couldn&apos;t load. Check your connection and try again.</span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setAttempt((value) => value + 1);
                  onSearchChange(`${search} `);
                  onSearchChange(search);
                }}
              >
                Try again
              </button>
            </p>
          ) : noResults ? (
            <EmptyState query={query} />
          ) : query !== "" && !loaded ? (
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
