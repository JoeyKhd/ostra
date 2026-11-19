"use client";

import { AnchorProvider, useActiveAnchor } from "fumadocs-core/toc";
import type { TOCItemType } from "fumadocs-core/toc";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { GithubIcon } from "./icons";

/** The headings a rail lists: the page's `h2`s. */
const headingsOf = (toc: readonly TOCItemType[]): TOCItemType[] => toc.filter((item) => item.depth === 2);

const Rows = ({ toc, onChoose }: { readonly toc: readonly TOCItemType[]; readonly onChoose?: () => void }) => {
  const active = useActiveAnchor();
  return (
    <ul className="toc-list">
      {headingsOf(toc).map((item) => {
        const id = item.url.replace(/^#/, "");
        return (
          <li key={item.url}>
            <a href={item.url} className="toc-row" aria-current={active === id ? "location" : undefined} onClick={onChoose}>
              {item.title}
            </a>
          </li>
        );
      })}
    </ul>
  );
};

/** "On this page": the right rail at desktop width (docs-guide.md). */
export const OnThisPage = ({ toc, editUrl, children }: { readonly toc: readonly TOCItemType[]; readonly editUrl: string; readonly children?: ReactNode }) => (
  <AnchorProvider toc={[...toc]} single>
    <aside className="toc-rail" aria-label="On this page">
      <p className="toc-title">On this page</p>
      <Rows toc={toc} />
      <div className="toc-foot">
        <a href={editUrl} className="edit-link">
          <GithubIcon size={15} />
          Edit on GitHub
        </a>
        {children}
      </div>
    </aside>
  </AnchorProvider>
);

/** "On this page" as the collapsible row above the title, under 1180px. */
export const OnThisPageRow = ({ toc }: { readonly toc: readonly TOCItemType[] }) => {
  const [open, setOpen] = useState(false);
  if (headingsOf(toc).length === 0) {
    return null;
  }
  return (
    <AnchorProvider toc={[...toc]} single>
      <div className="toc-row-collapsible needs-js">
        <button
          type="button"
          className="toc-row-button"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          On this page
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        {open ? (
          <Rows
            toc={toc}
            onChoose={() => {
              setOpen(false);
            }}
          />
        ) : null}
      </div>
    </AnchorProvider>
  );
};
