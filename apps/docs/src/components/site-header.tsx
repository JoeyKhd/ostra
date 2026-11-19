"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import { Menu, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { repoUrl, versionLabel } from "@/lib/site";

import { GithubIcon } from "./icons";
import { Logo } from "./logo";
import { ThemeToggle } from "./theme-toggle";

/** The event the phone's menu button sends to the docs layout's drawer. */
export const OPEN_NAV_EVENT = "ostra-docs:open-nav";

const useIsMac = (): boolean => {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/mac|iphone|ipad/i.test(navigator.userAgent));
  }, []);
  return mac;
};

export const SearchButton = () => {
  const { setOpenSearch } = useSearchContext();
  const mac = useIsMac();
  return (
    <button
      type="button"
      className="search-button needs-js"
      onClick={() => {
        setOpenSearch(true);
      }}
    >
      <Search size={15} strokeWidth={1.75} aria-hidden="true" />
      <span className="search-button-label">Search the docs</span>
      <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
};

const SearchIconButton = () => {
  const { setOpenSearch } = useSearchContext();
  return (
    <button
      type="button"
      className="icon-button phone-only needs-js"
      aria-label="Search the docs"
      onClick={() => {
        setOpenSearch(true);
      }}
    >
      <Search size={18} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
};

export const VersionChip = () => <span className="version-chip">{versionLabel}</span>;

/** The header every docs page shares (docs-home.md, "Header"). */
export const SiteHeader = ({ withMenu = false }: { readonly withMenu?: boolean }) => (
  <header className="site-header">
    <nav aria-label="Site" className="site-header-inner">
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      {withMenu ? (
        <button
          type="button"
          className="icon-button menu-button"
          aria-label="Open navigation"
          onClick={() => {
            window.dispatchEvent(new Event(OPEN_NAV_EVENT));
          }}
        >
          <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : null}
      <Link href="/" className="brand" aria-label="ostra docs home">
        <Logo />
      </Link>
      <span className="header-divider desktop-only" aria-hidden="true" />
      <Link href="/docs/start/what-ostra-is" className="header-docs desktop-only">
        Docs
      </Link>
      <span className="desktop-only">
        <VersionChip />
      </span>
      <div className="header-right">
        <span className="desktop-only">
          <SearchButton />
        </span>
        <a className="header-github desktop-only" href={repoUrl}>
          <GithubIcon size={16} />
          GitHub
        </a>
        <SearchIconButton />
        <ThemeToggle />
      </div>
    </nav>
  </header>
);
