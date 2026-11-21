"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/** The panel's sizes: the desktop's dense rows, or the phone sheet's 44px touch rows (app-shell.md, "Phone"). */
export type Density = "desktop" | "sheet";

const DensityContext = createContext<Density>("desktop");

export const DensityProvider = DensityContext.Provider;

export const useDensity = (): Density => useContext(DensityContext);

export type NavLinkProps = {
  readonly href: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  readonly end?: ReactNode;
  /** Match only this exact path (a project's Tasks), not its children. */
  readonly exact?: boolean;
  /** Whether it's the page, when the path alone can't say (Home's Overview and Board share `/`). */
  readonly current?: boolean;
  /** The full words, when the label truncates. */
  readonly title?: string;
  readonly onNavigate?: () => void;
};

/**
 * A row of the context panel (app-shell.md, "A row"): 28px, a 16px icon in `--faint`, Plex Sans 500
 * 14px `--text-2`; the page's row has the `--sel` fill with `--text`. In the phone sheet, 44px with
 * 15px words and an 18px icon. The arrows move between rows (`data-roving-item`).
 */
export const NavLink = ({ href, icon, children, end, exact = false, current, title, onNavigate }: NavLinkProps) => {
  const pathname = usePathname();
  const density = useDensity();
  const path = href.split("?")[0] ?? href;
  const active = current ?? (exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`));
  return (
    <Link
      href={href}
      data-roving-item=""
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
      {...(title === undefined ? {} : { title })}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center whitespace-nowrap rounded-sm font-medium text-text-2 hover:bg-hover hover:text-text [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-faint",
        density === "sheet" ? "h-11 gap-3 px-2.5 text-[15px] [&_svg]:size-[18px]" : "h-7 gap-2.5 px-2 text-ui [&_svg]:size-4",
        active && "bg-sel text-text hover:bg-sel [&_svg]:text-text",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end === undefined ? null : <span className="ml-auto flex shrink-0 items-center gap-1.5">{end}</span>}
    </Link>
  );
};

/** A count at a row's end: Plex Mono 500 12px `--faint` (12.5px in the sheet). */
export const RowCount = ({ n, label }: { readonly n: number; readonly label: string }) => {
  const density = useDensity();
  return (
    <span className={cn("font-mono font-medium text-faint", density === "sheet" ? "text-[12.5px]" : "text-xs")} aria-label={label}>
      {n}
    </span>
  );
};

/** The amber count pill, where something waits on the member: 18px (20px in the sheet). */
export const AmberCount = ({ n, label, testId }: { readonly n: number; readonly label: string; readonly testId?: string }) => {
  const density = useDensity();
  return (
    <span
      aria-label={label}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      className={cn("grid place-items-center rounded-full bg-amber px-[5px] font-mono font-semibold text-on-amber", density === "sheet" ? "h-5 min-w-5 text-xs" : "h-[18px] min-w-[18px] text-[11px]")}
    >
      {n}
    </span>
  );
};

/** A section label: Plex Sans 500 12px/1.45 `--faint`, with its count in mono and an optional button at its right. */
export const SectionLabel = ({ children, count, end }: { readonly children: string; readonly count?: number; readonly end?: ReactNode }) => {
  const density = useDensity();
  return (
    <div className={cn("flex items-center gap-1.5 font-medium leading-[1.45] text-faint", density === "sheet" ? "px-2.5 pb-1 pt-4 text-[12.5px]" : "px-2 pb-1 pt-4 text-xs")}>
      <span>{children}</span>
      {count === undefined ? null : <span className="font-mono">{count}</span>}
      {end === undefined ? null : <span className="ml-auto flex items-center">{end}</span>}
    </div>
  );
};
