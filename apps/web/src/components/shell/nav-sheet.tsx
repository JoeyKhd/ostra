"use client";

import { MenuIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { t } from "@/lib/messages";

import { SpacePanel } from "./context-panel";
import { Rail } from "./rail";
import { useShellState } from "./shell-state";

// The phone's navigation (F-147; app-shell.md, "Phone"; `shell-phone.webp`, `shell-phone-menu.webp`):
// below 768px there's no rail and no tab bar. The top bar's menu button, with an amber dot while
// something needs the member, opens one sheet from the left holding the rail and the open space's
// panel side by side. Focus is trapped in it, and goes back to the menu button however it closes.

export const NAV_SHEET_ID = "shell-nav-sheet";

/** The top bar's menu button: 44×44, `menu` at 20px, its amber dot while the member's needs-you count is above 0. */
export const MenuButton = ({ open, onOpen }: { readonly open: boolean; readonly onOpen: () => void }) => {
  const shell = useShellState();
  const count = shell.needsYou ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-shell-menu-button=""
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={NAV_SHEET_ID}
      aria-label={count > 0 ? t("shell.menu.openWithCount", { n: count }) : t("shell.openNavigation")}
      className="relative -ml-1.5 grid size-11 shrink-0 place-items-center rounded-md text-muted hover:text-text md:hidden"
    >
      <MenuIcon aria-hidden className="size-5 stroke-[1.75]" />
      {count > 0 ? <span aria-hidden data-testid="menu-needs-you-dot" className="menu-dot absolute right-[9px] top-[10px] size-2 rounded-full bg-amber" /> : null}
    </button>
  );
};

/** Gives the focus to the top bar's menu button (the one on screen). */
const focusMenuButton = (): void => {
  [...document.querySelectorAll<HTMLElement>("[data-shell-menu-button]")].find((one) => one.getClientRects().length > 0)?.focus();
};

/** The focus the sheet starts on: the page's row in the panel, else the lit space in the rail. */
const startFocus = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>("[data-shell-panel] [aria-current='page']") ?? root.querySelector<HTMLElement>("[data-shell-rail] [aria-current='page']") ?? root.querySelector<HTMLElement>("[data-shell-rail] [data-roving-item]");

export const NavSheet = ({ open, onOpenChange, onSearch }: { readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly onSearch: () => void }) => {
  const shell = useShellState();
  const pathname = usePathname();
  // Closed by a chosen page, the focus goes to the new page's menu button once it's drawn.
  const refocus = useRef(false);
  // A page chosen anywhere closes it, the top bar's own links among them.
  useEffect(() => {
    onOpenChange(false);
    if (!refocus.current) return undefined;
    refocus.current = false;
    // The router puts the focus on the new page's segment once it's drawn; the menu button takes it
    // back then, unless the member already moved it somewhere.
    const timers = [0, 120, 400].map((ms) =>
      setTimeout(() => {
        const active = document.activeElement;
        const onControl = active !== null && active !== document.body && active.closest("a, button, input, textarea, select, [tabindex]") !== null;
        if (!onControl) focusMenuButton();
      }, ms),
    );
    return () => { for (const timer of timers) clearTimeout(timer); };
  }, [pathname, onOpenChange]);
  // A link chosen in the sheet closes it before its page is drawn: that page's button gets the focus then.
  const close = () => {
    refocus.current = true;
    setTimeout(() => { refocus.current = false; }, 5_000);
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        id={NAV_SHEET_ID}
        side="left"
        title={t("shell.navigation")}
        closeButton={false}
        data-testid="nav-sheet"
        onOpenAutoFocus={(event) => {
          const root = document.getElementById(NAV_SHEET_ID);
          const target = root === null ? null : startFocus(root);
          if (target === null) return;
          event.preventDefault();
          target.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          focusMenuButton();
        }}
        className="w-[min(calc(100vw-56px),384px)] flex-row overflow-hidden border-line-2 bg-bg shadow-(--shadow-pop) md:hidden"
      >
        <Rail sheet onNavigate={close} onSearch={() => { close(); onSearch(); }} />
        <div className="min-w-0 flex-1 border-l border-line bg-bg">
          <SpacePanel space={shell.space} mode="sheet" onNavigate={close} />
        </div>
      </SheetContent>
    </Sheet>
  );
};
