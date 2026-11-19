"use client";

import { useHighlightQuery } from "fumadocs-core/search/client";
import { Filter, Link as LinkIcon, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { defaultKindOf } from "@/lib/configuration-reference";
import type { ReadBy, ReferenceGroup, SettingRow } from "@/lib/configuration-reference";

import { useCopyLink } from "./heading-anchor";
import { MarkdownBlock, renderInline } from "./inline-markdown";

type ReadFilter = "all" | ReadBy;

const segments = [
  { value: "all", label: "All" },
  { value: "server", label: "Server" },
  { value: "runner", label: "Runner" },
  { value: "dev", label: "Development" },
] as const satisfies readonly { value: ReadFilter; label: string }[];

const readByLines = {
  server: "Read by core and the panel",
  runner: "Read by ostra runner · each is also a flag",
  dev: "Read only in development and tests",
} as const satisfies Record<ReadBy, string>;

const isReadFilter = (value: string | null): value is ReadFilter => segments.some((segment) => segment.value === value);

const words = (query: string): string[] => query.toLowerCase().split(/\s+/).filter((word) => word !== "");

const matches = (row: SettingRow, query: string): boolean => {
  const haystack = [row.name, row.flag ?? "", row.defaultValue, row.description].join(" ").toLowerCase();
  return words(query).every((word) => haystack.includes(word));
};

const DefaultCell = ({ value, names }: { readonly value: string; readonly names: ReadonlySet<string> }) => {
  const kind = defaultKindOf(value);
  switch (kind) {
    case "required":
      return <em className="default-marker">required</em>;
    case "none":
      return <em className="default-marker">none</em>;
    case "value":
      return <span className={/^`[^`]*`$/.test(value.trim()) ? "default-value is-code" : "default-value"}>{renderInline(value, names)}</span>;
    default:
      return kind satisfies never;
  }
};

const Row = ({ row, names }: { readonly row: SettingRow; readonly names: ReadonlySet<string> }) => {
  const { copied, copy } = useCopyLink(1500);
  return (
    <tr id={row.name} className="setting-row">
      <th scope="row" className="setting-name-cell">
        <span className="setting-name-line">
          <button
            type="button"
            className="row-link needs-js"
            aria-label={`Copy link to ${row.name}`}
            onClick={() => {
              copy(row.name);
            }}
          >
            <LinkIcon size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className={copied ? "tooltip is-shown" : "tooltip"} aria-live="polite">
              {copied ? "Link copied" : ""}
            </span>
          </button>
          <a href={`#${row.name}`} className="setting-name">
            {row.name}
          </a>
          <span className="read-chip">{row.readBy}</span>
        </span>
        {row.flag === null ? null : <span className="setting-flag">{row.flag}</span>}
      </th>
      <td className="setting-default" data-label="Default">
        <DefaultCell value={row.defaultValue} names={names} />
      </td>
      <td className="setting-description">{renderInline(row.description, names)}</td>
    </tr>
  );
};

const Intro = ({ markdown, names }: { readonly markdown: string; readonly names: ReadonlySet<string> }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "group-intro is-open" : "group-intro"}>
      <MarkdownBlock markdown={markdown} settingNames={names} />
      {open ? null : (
        <button
          type="button"
          className="text-button needs-js"
          onClick={() => {
            setOpen(true);
          }}
        >
          More
        </button>
      )}
    </div>
  );
};

/**
 * The settings, by group, with the filter, the "Read by" segments and an anchor per row
 * (docs-reference.md). The groups are the file's, in its order.
 */
export const SettingsReference = ({ groups }: { readonly groups: readonly ReferenceGroup[] }) => {
  const [query, setQuery] = useState("");
  const [read, setRead] = useState<ReadFilter>("all");
  const field = useRef<HTMLInputElement>(null);
  const highlight = useHighlightQuery(query);

  const rows = useMemo(
    () => groups.flatMap((group) => group.blocks.flatMap((block) => (block.kind === "settings" ? block.rows : []))),
    [groups],
  );
  const names = useMemo(() => new Set(rows.map((row) => row.name)), [rows]);
  const count = (value: ReadFilter): number => rows.filter((row) => value === "all" || row.readBy === value).length;
  const shown = rows.filter((row) => (read === "all" || row.readBy === read) && matches(row, query));
  const filtering = query.trim() !== "" || read !== "all";

  // The filter and the segment live in the URL (`?q=port&read=server`), so a view can be shared.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQuery(params.get("q") ?? "");
    const fromUrl = params.get("read");
    if (isReadFilter(fromUrl)) {
      setRead(fromUrl);
    }
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query === "") {
      url.searchParams.delete("q");
    } else {
      url.searchParams.set("q", query);
    }
    if (read === "all") {
      url.searchParams.delete("read");
    } else {
      url.searchParams.set("read", read);
    }
    window.history.replaceState(window.history.state, "", url);
  }, [query, read]);
  // `/` focuses the filter when no field has focus; ⌘K still opens search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        field.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const total = count("all");
  return (
    <div className="settings-reference">
      <div className="filter-row needs-js" data-settings-filter>
        <label className="filter-field">
          <Filter size={15} strokeWidth={1.75} aria-hidden="true" />
          <input
            ref={field}
            type="search"
            aria-label="Filter settings"
            placeholder="Filter by name or words"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </label>
        <div className="segments" role="radiogroup" aria-label="Read by">
          {segments.map((segment) => (
            <button
              key={segment.value}
              type="button"
              role="radio"
              aria-checked={read === segment.value}
              className="segment"
              onClick={() => {
                setRead(segment.value);
              }}
            >
              {segment.label}
              <span className="segment-count">{count(segment.value)}</span>
            </button>
          ))}
        </div>
        <p className="filter-count" aria-live="polite">
          {filtering ? `${String(shown.length)} of ${String(total)} settings` : `${String(total)} settings`}
        </p>
      </div>
      {filtering && shown.length === 0 ? (
        <p className="no-match">
          <SearchX size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>No setting matches “{query}”.</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setQuery("");
              setRead("all");
            }}
          >
            Clear the filter
          </button>
        </p>
      ) : null}
      {/* Keyed by the filter, so the highlight's ref runs again on the rows it leaves. */}
      <div ref={highlight} key={`${query}-${read}`}>
      {groups.map((group) => {
        const groupRows = group.blocks.flatMap((block) => (block.kind === "settings" ? block.rows : []));
        const visible = groupRows.filter((row) => shown.includes(row));
        if (filtering && (group.readBy === null || visible.length === 0)) {
          return null;
        }
        const firstSettings = group.blocks.findIndex((block) => block.kind === "settings");
        return (
          <section key={group.slug} className="settings-group" aria-labelledby={group.slug}>
            <div className="group-band">
              <h2 id={group.slug}>
                {group.heading}
                {group.readBy === null ? null : <span className="group-count">{filtering ? visible.length : groupRows.length}</span>}
              </h2>
              {group.readBy === null ? null : <span className="group-read-by">{readByLines[group.readBy]}</span>}
            </div>
            {group.blocks.map((block, index) => {
              if (block.kind === "settings") {
                return (
                  <table key={`table-${String(index)}`} className="settings-table">
                    <caption className="sr-only">{group.heading}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Setting</th>
                        <th scope="col">Default</th>
                        <th scope="col">What it does</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(filtering ? block.rows.filter((row) => shown.includes(row)) : block.rows).map((row) => (
                        <Row key={row.name} row={row} names={names} />
                      ))}
                    </tbody>
                  </table>
                );
              }
              if (filtering) {
                return null;
              }
              return index < firstSettings && group.readBy !== null ? (
                <Intro key={`intro-${String(index)}`} markdown={block.markdown} names={names} />
              ) : (
                <div key={`prose-${String(index)}`} className="group-prose">
                  <MarkdownBlock markdown={block.markdown} settingNames={names} />
                </div>
              );
            })}
          </section>
        );
      })}
      </div>
    </div>
  );
};
