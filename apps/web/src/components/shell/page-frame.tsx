"use client";

import { ArrowRightIcon, ChevronRightIcon, PanelLeftOpenIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useRef, useState } from "react";
import type { PointerEvent, ReactNode } from "react";

import { Dot } from "@/components/ui/status";
import type { Tone } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { useShell } from "./app-shell";
import { DefaultPasswordBanner } from "./default-password-banner";
import { MenuButton } from "./nav-sheet";
import { useOptionalShellState } from "./shell-state";

export type Crumb = { readonly label: string; readonly href?: string };

export type PageFrameProps = {
  readonly crumbs: readonly Crumb[];
  readonly actions?: ReactNode;
  /** The 320px properties panel (380px when it holds a form). Stacks below at phone width. */
  readonly properties?: ReactNode;
  /**
   * Under 640px, `sheet`: the page opens its properties in a bottom sheet of its own (the task
   * page's `Details` row, m2's `phone-task`), so they don't stack under it. `stacked` by default.
   */
  readonly phoneProperties?: "stacked" | "sheet";
  readonly wideProperties?: boolean;
  /** Pages that scroll their own content (the task thread) pass false. */
  readonly padded?: boolean;
  /** A side pane in place of the properties panel: the task page's preview (milestone 8, F-141). */
  readonly pane?: SidePane;
  /**
   * Below 768px, the page's title over its line in place of the breadcrumb: a task's
   * `CALC-192 · ● Running` (app-shell.md, "Phone").
   */
  readonly phoneTitle?: { readonly title: string; readonly line: ReactNode };
  readonly children: ReactNode;
};

/**
 * A side pane beside the page (task-preview.md, "Layout"): the page keeps `clamp(440px, 44%,
 * 560px)` and the pane the rest, with a 1px divider that drags (the page at least 440, the pane at
 * least 420; a double-click resets it). Expanded, the pane takes the whole width and the page beside
 * it hides: only the grid's columns change, so neither moves in the DOM (nothing in them reloads).
 * Below 1024px the two never share the screen: the switch under the top bar shows one.
 */
export type SidePane = {
  readonly node: ReactNode;
  readonly expanded: boolean;
  /** Below 1024px: which of the two shows. */
  readonly narrow: "page" | "pane";
  /** The `Chat | Preview` switch, under the top bar below 1024px. */
  readonly switcher: ReactNode;
};

/** The page's least width beside a side pane, and the pane's (task-preview.md). */
const PAGE_MIN = 440;
const PANE_MIN = 420;

/**
 * The 46px top bar with breadcrumbs and the page's actions (54px at phone width, with the menu
 * button that opens the rail and the panel as one sheet, F-147), the default-password banner under it
 * while it applies, the page (padding 26px 36px, milestone 8's targets: m1's measured 28px set every
 * heading a little low), and its properties panel (320px, or 380px for a form; padding 20px 18px),
 * which stacks under the page below `xl`. The other sizes are the approved pictures'
 * (app-targets/m1/README.md, "Scale").
 */
export const PageFrame = ({ crumbs, actions, properties, phoneProperties = "stacked", wideProperties = false, padded = true, pane, phoneTitle, children }: PageFrameProps) => {
  const { openNavigation, navigationOpen, passwordChange } = useShell();
  const shell = useOptionalShellState();
  // Below 768px a project's page with no action of its own offers New task in the project, as a
  // 44px `plus` (app-shell.md, "Phone": the page's one main action).
  const place = shell?.place;
  const projectId = place?.space === "projects" && place.taskId === null ? place.projectId : null;
  const project = crumbs[0]?.label ?? "";
  const phoneAction =
    actions !== undefined || projectId === null || project === "" ? null : (
      <Link
        href={`/tasks/new?project=${encodeURIComponent(projectId)}`}
        aria-label={t("shell.panel.newTaskIn", { project })}
        title={t("shell.panel.newTaskIn", { project })}
        className="ml-auto grid size-11 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-text md:hidden"
      >
        <PlusIcon aria-hidden className="size-5 stroke-[1.75]" />
      </Link>
    );
  const path = usePathname();
  const split = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState<number | null>(null);
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const node = split.current;
    if (node === null || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = node.getBoundingClientRect();
    setPageWidth(Math.round(Math.min(Math.max(PAGE_MIN, event.clientX - rect.left), Math.max(PAGE_MIN, rect.width - PANE_MIN))));
  };
  // One frame for both layouts, so the page (`main`) never remounts when a side pane comes or goes.
  const columns = pane === undefined ? undefined : pane.expanded ? "minmax(0,1fr)" : `${pageWidth === null ? "clamp(440px,44%,560px)" : `${String(pageWidth)}px`} minmax(0,1fr)`;
  return (
    <>
      <header className="flex h-[54px] shrink-0 items-center gap-2 border-b border-line bg-bg px-1.5 text-muted md:h-[46px] md:px-[18px]">
        {shell === null ? null : <MenuButton open={navigationOpen} onOpen={openNavigation} />}
        {/* F-147: with the panel collapsed, the top bar's first item docks it again (`shell-peek.webp`). */}
        {shell === null ? null : (
          <button
            type="button"
            onClick={shell.dock}
            aria-label={t("shell.panel.show")}
            title={t("shell.panel.show")}
            data-testid="show-sidebar"
            className={cn(
              "-ml-2 hidden size-7 shrink-0 place-items-center rounded-sm text-muted hover:bg-hover hover:text-text",
              !shell.opened && "md:max-xl:grid",
              shell.choice.collapsed && !shell.opened && "xl:grid",
              shell.held && "md:grid",
            )}
          >
            <PanelLeftOpenIcon aria-hidden className="size-4 stroke-[1.75]" />
          </button>
        )}
        {phoneTitle === undefined ? null : (
          <div className="min-w-0 flex-1 md:hidden" data-testid="phone-title">
            <p className="truncate text-[15px] font-semibold leading-5 text-text">{phoneTitle.title}</p>
            <p className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs leading-4 text-faint">{phoneTitle.line}</p>
          </div>
        )}
        <nav aria-label={t("shell.breadcrumbs")} className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-base md:gap-2 md:text-body", phoneTitle !== undefined && "max-md:hidden")}>
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.label}-${String(i)}`}>
                {i > 0 ? <ChevronRightIcon aria-hidden className="size-[15px] shrink-0 text-faint md:size-[14px]" /> : null}
                {/* The parents give way first (shrink 5), the page's own name last (shrink 1). Its factor
                    stays at least 1: once the parents are cut to nothing, a flex item alone with a
                    factor under 1 takes only that share of what is still too wide, and the bar ran
                    past a phone's edge on a long note's title. */}
                {last || crumb.href === undefined ? (
                  <span className={cn("min-w-0 truncate", last ? "font-semibold text-text md:font-medium" : "shrink-[5] font-medium")} aria-current={last ? "page" : undefined}>
                    {crumb.label}
                  </span>
                ) : (
                  <Link href={crumb.href} className="min-w-0 shrink-[5] truncate font-medium hover:text-text md:font-normal">
                    {crumb.label}
                  </Link>
                )}
              </Fragment>
            );
          })}
        </nav>
        {actions === undefined ? null : <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
        {phoneAction}
      </header>
      <DefaultPasswordBanner passwordChange={passwordChange} path={path} />
      <div className={cn("shrink-0 lg:hidden", pane === undefined && "hidden")}>{pane?.switcher}</div>
      <div
        ref={split}
        data-testid={pane === undefined ? undefined : "side-split"}
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          pane !== undefined
            ? "lg:grid"
            : properties === undefined
              ? "xl:grid xl:grid-cols-1"
              : wideProperties
                ? "xl:grid xl:grid-cols-[minmax(0,1fr)_380px]"
                : "xl:grid xl:grid-cols-[minmax(0,1fr)_320px]",
        )}
        style={columns === undefined ? undefined : { gridTemplateColumns: columns }}
      >
        <main
          className={cn(
            "min-w-0 min-h-0",
            pane === undefined ? "xl:overflow-y-auto" : "lg:overflow-y-auto",
            pane?.expanded === true && "lg:hidden",
            pane?.narrow === "pane" && "max-lg:hidden",
            padded && "px-4 pb-8 pt-6 sm:px-9 sm:pt-[26px]",
          )}
        >
          {children}
        </main>
        {pane !== undefined ? (
          <div className={cn("relative min-h-0 min-w-0 max-lg:h-[calc(100dvh-104px)]", !pane.expanded && "lg:border-l lg:border-line", pane.narrow === "page" && "max-lg:hidden")} data-testid="side-pane">
            {pane.expanded ? null : (
              <div
                aria-hidden
                onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={drag}
                onDoubleClick={() => { setPageWidth(null); }}
                className="absolute inset-y-0 -left-[3px] z-[4] hidden w-1.5 cursor-col-resize lg:block"
              />
            )}
            {pane.node}
          </div>
        ) : null}
        {/* Beside a side pane the properties show only below 1024px, under the page, as they always did there. */}
        {properties === undefined || pane?.narrow === "pane" ? null : (
          <aside
            aria-label={t("shell.properties")}
            className={cn("min-w-0 border-t border-line px-4 py-5 sm:px-[18px] xl:overflow-y-auto xl:border-l xl:border-t-0", pane !== undefined && "lg:hidden", phoneProperties === "sheet" && "max-sm:hidden")}
          >
            {properties}
          </aside>
        )}
      </div>
    </>
  );
};

/** A page's key line over its title (milestone 8's `.key`): Plex Mono 13px `--faint`, one 17px line. */
export const pageKeyLine = "font-mono text-sm leading-[17px] text-faint";

/**
 * The title's margins (milestone 8's `h1`): 4px under a key line, none at the page's top, 6px over
 * the lede. With the page's 26px top, a title starts 26px down, or 47px under a key line.
 */
export const pageTitleGap = (keyed: boolean): string => (keyed ? "mt-1 mb-1.5" : "mt-0 mb-1.5");

/** The page heading: an optional key line, the title (Manrope 700, 26px) and a one-line lede. */
export const PageHeading = ({ eyebrow, title, lede, children }: { readonly eyebrow?: ReactNode; readonly title: string; readonly lede?: ReactNode; readonly children?: ReactNode }) => (
  <div className="mb-2">
    {eyebrow === undefined ? null : <div className={pageKeyLine}>{eyebrow}</div>}
    <h1 className={cn("page-title break-words", pageTitleGap(eyebrow !== undefined))}>{title}</h1>
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

export const PropGroup = ({ title, children }: { readonly title: ReactNode; readonly children: ReactNode }) => (
  <div className="mb-3.5 border-b border-line pb-3.5 last:border-b-0">
    <h3 className="mb-2 text-xs font-medium text-faint">{title}</h3>
    {children}
  </div>
);
