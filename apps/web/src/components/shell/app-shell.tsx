"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { StreamProvider } from "@/task/stream-provider";
import { cn } from "@/lib/cn";
import type { RouterOutputs } from "@/lib/trpc";

import { ShellActions, useShellActions } from "./actions/shell-actions";
import { ActionScopeProvider } from "./actions/use-scope";
import { ResizeHandle, SpacePanel } from "./context-panel";
import { NavSheet } from "./nav-sheet";
import { Peek, RailOverlay } from "./peek";
import { Rail } from "./rail";
import { ShellStateProvider, useShellState } from "./shell-state";
import type { SidebarChoice } from "./sidebar-state";

type ShellContext = {
  /** Opens the phone's menu sheet (the rail and the panel). */
  readonly openNavigation: () => void;
  readonly navigationOpen: boolean;
  /** Opens the command palette (F-080, F-081): the rail's Search. */
  readonly openSearch: () => void;
  /** Whether the account still has its default password: PageFrame shows the banner under its top bar. */
  readonly passwordChange: RouterOutputs["me"]["get"]["passwordChange"];
};

const ShellContextValue = createContext<ShellContext>({ openNavigation: () => undefined, navigationOpen: false, openSearch: () => undefined, passwordChange: "none" });

/** Lets the top bar open the phone's menu sheet, and show the default-password banner. */
export const useShell = (): ShellContext => useContext(ShellContextValue);

/**
 * The docked panel beside the rail. Its width animates to 0 over 160ms when it collapses (at once
 * with reduced motion), and it's `inert` then. The saved choice draws it on the server (no flash at
 * 1280 and up); from 1024 to 1279 a class keeps it collapsed until the member opens it.
 */
const DockedPanel = () => {
  const shell = useShellState();
  const width = shell.choice.width;
  const open = (!shell.choice.collapsed || shell.opened) && !shell.held;
  return (
    <div
      data-testid="context-panel"
      data-collapsed={shell.shown ? "false" : "true"}
      data-place={shell.placed ? shell.space : "none"}
      data-place-row={shell.place.row ?? ""}
      inert={shell.band !== null && !shell.shown}
      style={{ width: open ? width : 0 }}
      className={cn(
        "relative hidden h-full shrink-0 bg-bg transition-[width,visibility] duration-[160ms] ease-out motion-reduce:transition-none lg:block",
        open ? "visible border-r border-line" : "invisible",
        !shell.opened && "lg:max-xl:invisible lg:max-xl:w-0! lg:max-xl:border-r-0",
      )}
    >
      <div className="h-full overflow-hidden" style={{ width }}>
        <SpacePanel space={shell.space} mode="docked" />
      </div>
      {shell.shown ? <ResizeHandle /> : null}
    </div>
  );
};

const Frame = ({ children }: { readonly children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const { openPalette } = useShellActions();
  const shell = useShellState();
  const openSearch = useCallback(() => { setOpen(false); openPalette(null); }, [openPalette]);
  const value = useMemo(() => ({ openNavigation: () => { setOpen(true); }, navigationOpen: open, openSearch, passwordChange: shell.me.passwordChange }), [open, openSearch, shell.me.passwordChange]);
  return (
    <ShellContextValue.Provider value={value}>
      <div className="min-h-dvh md:flex md:h-dvh md:overflow-hidden">
        <div className="hidden h-full md:block">
          <Rail onSearch={openSearch} />
        </div>
        <DockedPanel />
        <NavSheet open={open} onOpenChange={setOpen} onSearch={openSearch} />
        <div className="flex min-h-dvh min-w-0 flex-1 flex-col md:min-h-0">{children}</div>
        <Peek />
        <RailOverlay />
      </div>
    </ShellContextValue.Provider>
  );
};

/**
 * The panel's frame (F-147; app-shell.md, "Layout"): the 64px rail, the 240px context panel (200 to
 * 320, collapsible, peeking), then the page. Below 768px the rail and the panel open together as the
 * top bar's menu sheet. The palette, the shortcuts and the `?` sheet are the shell's (F-081).
 */
export const AppShell = ({ me, sidebar, children }: { readonly me: RouterOutputs["me"]["get"]; readonly sidebar: SidebarChoice; readonly children: ReactNode }) => (
  <StreamProvider>
    <ActionScopeProvider>
      <ShellStateProvider me={me} initial={sidebar}>
        <ShellActions me={me}>
          <Frame>{children}</Frame>
        </ShellActions>
      </ShellStateProvider>
    </ActionScopeProvider>
  </StreamProvider>
);
