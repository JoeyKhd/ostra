"use client";

import { ArrowRightIcon, ChevronRightIcon, MenuIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import type { ReactNode } from "react";

import { Dot } from "@/components/ui/status";
import type { Tone } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useShell } from "./app-shell";
import { DefaultPasswordBanner } from "./default-password-banner";

export type Crumb = { readonly label: string; readonly href?: string };

export type PageFrameProps = {
  readonly crumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  /** The 320px properties panel (380px when it holds a form). Stacks below at phone width. */
  readonly properties?: ReactNode;
  readonly wideProperties?: boolean;
  /** Pages that scroll their own content (the task thread) pass false. */
  readonly padded?: boolean;
  readonly children: ReactNode;
};

/**
 * The 46px top bar with breadcrumbs and the page's actions, the default-password banner under it
 * while it applies, the page (padding 28px 36px), and its properties panel (320px, or 380px for a
 * form; padding 20px 18px), which stacks under the page below `xl`. The sizes are the approved
 * pictures' (app-targets/m1/README.md, "Scale").
 */
export const PageFrame = ({ crumbs, actions, properties, wideProperties = false, padded = true, children }: PageFrameProps) => {
  const { openNavigation, openSearch, passwordChange } = useShell();
  const path = usePathname();
  return (
    <>
      <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-line px-3 text-muted sm:px-[18px]">
        <button
          type="button"
          onClick={openNavigation}
          className="-ml-1 rounded-sm p-1 text-muted hover:text-text lg:hidden"
          aria-label={t("shell.openNavigation")}
        >
          <MenuIcon className="size-[18px]" />
        </button>
        <nav aria-label={t("shell.breadcrumbs")} className="flex min-w-0 items-center gap-2">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.label}-${String(i)}`}>
                {i > 0 ? <ChevronRightIcon aria-hidden className="hidden size-[14px] shrink-0 text-faint sm:block" /> : null}
                {last || crumb.href === undefined ? (
                  <span className={cn("truncate", last ? "font-medium text-text" : "hidden sm:inline")} aria-current={last ? "page" : undefined}>
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className="hidden truncate hover:text-text sm:inline">
                    {crumb.label}
                  </Link>
                )}
              </Fragment>
            );
          })}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* F-080 (ticket 35): the top bar's way in to the search palette, beside the sidebar's box. */}
          <button
            type="button"
            onClick={openSearch}
            aria-label={t("search.palette.open")}
            data-testid="topbar-search"
            className="flex h-[30px] items-center gap-2 rounded-md border border-line bg-surface px-2 text-faint hover:border-line-2 hover:text-muted md:w-[200px] md:px-2.5"
          >
            <SearchIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75]" />
            <span className="hidden text-ui md:inline">{t("shell.search")}</span>
            <kbd className="ml-auto hidden font-mono text-[11.5px] font-medium md:inline">⌘K</kbd>
          </button>
          {actions}
        </div>
      </header>
      <DefaultPasswordBanner passwordChange={passwordChange} path={path} />
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col xl:grid",
          properties === undefined
            ? "xl:grid-cols-1"
            : wideProperties
              ? "xl:grid-cols-[minmax(0,1fr)_380px]"
              : "xl:grid-cols-[minmax(0,1fr)_320px]",
        )}
      >
        <main className={cn("min-w-0 min-h-0 xl:overflow-y-auto", padded && "px-4 pb-8 pt-6 sm:px-9 sm:pt-7")}>{children}</main>
        {properties === undefined ? null : (
          <aside
            aria-label={t("shell.properties")}
            className="min-w-0 border-t border-line px-4 py-5 sm:px-[18px] xl:overflow-y-auto xl:border-l xl:border-t-0"
          >
            {properties}
          </aside>
        )}
      </div>
    </>
  );
};

/** The page heading: an optional key line, the title (Manrope 700, 26px) and a one-line lede. */
export const PageHeading = ({ eyebrow, title, lede, children }: { readonly eyebrow?: ReactNode; readonly title: string; readonly lede?: ReactNode; readonly children?: ReactNode }) => (
  <div className="mb-2">
    {eyebrow === undefined ? null : <div className="font-mono text-sm text-faint">{eyebrow}</div>}
    <h1 className="page-title my-1.5 break-words">{title}</h1>
    {lede === undefined ? null : <p className="max-w-[720px] text-lede text-muted">{lede}</p>}
    {children}
  </div>
);

export type SectionProps = {
  readonly title: string;
  readonly count?: number;
  /** A short `--muted` note after the title, on its line (storage: what the blob store holds). */
  readonly note?: string;
  /** A dot before the title: `amber` for Needs you (grey when it's empty), and nothing else. */
  readonly tone?: Tone;
  /** The right-hand end of the title line: a `More →` link (`SectionLink`). */
  readonly end?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
};

/** A section: a 30px title line and its rows, no box (app-design.md, rule 3; graphite.css `.shead`). */
export const Section = ({ title, count, note, tone, end, children, className }: SectionProps) => (
  <section className={cn("mt-[26px]", className)}>
    <div className="mb-1 flex h-[30px] items-center gap-2">
      {tone === undefined ? null : <Dot tone={tone} className="mr-0.5" />}
      <h2 className="text-body font-semibold">{title}</h2>
      {count === undefined ? null : <span className="font-mono text-[12.5px] text-faint">{count}</span>}
      {note === undefined ? null : <span className="ml-1.5 hidden truncate text-sm text-muted sm:inline">{note}</span>}
      {end === undefined ? null : <div className="ml-auto flex items-center gap-2 text-sm text-muted">{end}</div>}
    </div>
    {children}
  </section>
);

/** The `Open all →` link at the end of a section's title line: 13px `--muted`, a 13px arrow. */
export const SectionLink = ({ href, children }: { readonly href: string; readonly children: ReactNode }) => (
  <Link href={href} className="flex items-center gap-1 text-sm text-muted hover:text-text">
    {children}
    <ArrowRightIcon aria-hidden className="size-[13px] stroke-[1.75]" />
  </Link>
);

/** One key/value row of a properties panel. `labelWidth` widens the key column (storage: 150px). */
export const PropRow = ({ label, children, labelWidth, labelClassName }: { readonly label: string; readonly children: ReactNode; readonly labelWidth?: number; readonly labelClassName?: string }) => (
  <div
    className="grid min-h-8 grid-cols-[92px_minmax(0,1fr)] items-center gap-2 text-ui"
    {...(labelWidth === undefined ? {} : { style: { gridTemplateColumns: `${String(labelWidth)}px minmax(0,1fr)` } })}
  >
    <span className={cn("min-w-0 truncate text-muted", labelClassName)}>{label}</span>
    <span className="flex min-w-0 items-center gap-[7px] text-text [&_svg]:size-[14px] [&_svg]:text-muted">{children}</span>
  </div>
);

export const PropGroup = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0">
    <h3 className="mb-2 text-xs font-medium text-faint">{title}</h3>
    {children}
  </div>
);
