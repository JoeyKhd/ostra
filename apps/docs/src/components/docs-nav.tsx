"use client";

import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useSearchContext } from "fumadocs-ui/contexts/search";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { NavSection } from "@/lib/navigation";
import { basePath, repoUrl } from "@/lib/site";

import { GithubIcon } from "./icons";
import { Logo } from "./logo";
import { OPEN_NAV_EVENT, VersionChip } from "./site-header";

/** The path without the base path and the trailing slash, as the page tree writes URLs. */
const usePagePath = (): string => {
  const pathname = usePathname();
  const path = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname;
  return path.length > 1 ? path.replace(/\/$/, "") : path;
};

const NavTree = ({ sections, onNavigate }: { readonly sections: readonly NavSection[]; readonly onNavigate?: () => void }) => {
  const current = usePagePath();
  const currentSection = sections.find((section) => section.pages.some((page) => page.url === current))?.title;
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const first = sections[0]?.title;
  const isOpen = (title: string): boolean => title === currentSection || title === first || opened.has(title);
  return (
    <ul className="nav-sections">
      {sections.map((section) => {
        const open = isOpen(section.title);
        const pinned = section.title === currentSection || section.title === first;
        return (
          <li key={section.title} className={open ? "nav-section is-open" : "nav-section"}>
            {pinned ? (
              <p className="nav-label">{section.title}</p>
            ) : (
              <button
                type="button"
                className="nav-toggle"
                aria-expanded={open}
                onClick={() => {
                  setOpened((previous) => {
                    const next = new Set(previous);
                    if (next.has(section.title)) {
                      next.delete(section.title);
                    } else {
                      next.add(section.title);
                    }
                    return next;
                  });
                }}
              >
                {section.title}
                {open ? <ChevronDown size={15} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" />}
              </button>
            )}
            {open ? (
              <ul className="nav-pages">
                {section.pages.map((page) => (
                  <li key={page.url}>
                    <Link
                      href={page.url}
                      className="nav-page"
                      aria-current={page.url === current ? "page" : undefined}
                      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
};

/** The navigation by section (docs-guide.md, "Navigation"). */
export const DocsNav = ({ sections }: { readonly sections: readonly NavSection[] }) => (
  <nav aria-label="Docs" className="docs-nav">
    <NavTree sections={sections} />
  </nav>
);

/** The phone's drawer (docs-guide.md, "Phone"): opened by the header's menu button. */
export const DocsDrawer = ({ sections }: { readonly sections: readonly NavSection[] }) => {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const { setOpenSearch } = useSearchContext();
  const close = useCallback(() => {
    setOpen(false);
    if (opener.current instanceof HTMLElement) {
      opener.current.focus();
    }
  }, []);
  useEffect(() => {
    const onOpen = () => {
      opener.current = document.activeElement;
      setOpen(true);
    };
    window.addEventListener(OPEN_NAV_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_NAV_EVENT, onOpen);
    };
  }, []);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    panel.current?.querySelector<HTMLElement>("button, a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
      if (event.key === "Tab" && panel.current !== null) {
        const focusable = [...panel.current.querySelectorAll<HTMLElement>("a, button")];
        const firstItem = focusable[0];
        const lastItem = focusable.at(-1);
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault();
          lastItem?.focus();
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault();
          firstItem?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  if (!open) {
    return null;
  }
  return (
    <div className="drawer-root">
      <div className="drawer-scrim" aria-hidden="true" onClick={close} />
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-label="Navigation">
        <div className="drawer-top">
          <Logo />
          <button type="button" className="icon-button" aria-label="Close navigation" onClick={close}>
            <X size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className="drawer-search"
          onClick={() => {
            setOpen(false);
            setOpenSearch(true);
          }}
        >
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          Search the docs
        </button>
        <nav aria-label="Docs" className="drawer-nav">
          <NavTree sections={sections} onNavigate={close} />
        </nav>
        <div className="drawer-foot">
          <a href={repoUrl} className="header-github">
            <GithubIcon size={16} />
            GitHub
          </a>
          <VersionChip />
        </div>
      </div>
    </div>
  );
};
