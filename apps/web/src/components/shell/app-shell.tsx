"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { StreamProvider } from "@/task/stream-provider";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { ShellActions, useShellActions } from "./actions/shell-actions";
import { ActionScopeProvider } from "./actions/use-scope";
import { Sidebar } from "./sidebar";

type ShellContext = {
  readonly openNavigation: () => void;
  /** Opens the command palette (F-080, F-081): the sidebar's search box and the top bar's search field. */
  readonly openSearch: () => void;
  /** Whether the account still has its default password: PageFrame shows the banner under its top bar. */
  readonly passwordChange: RouterOutputs["me"]["get"]["passwordChange"];
};

const ShellContextValue = createContext<ShellContext>({ openNavigation: () => undefined, openSearch: () => undefined, passwordChange: "none" });

/** Lets the top bar open the sidebar drawer at phone width, and show the default-password banner. */
export const useShell = (): ShellContext => useContext(ShellContextValue);

const Frame = ({ me, children }: { readonly me: RouterOutputs["me"]["get"]; readonly children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  const { openPalette } = useShellActions();
  return (
    <ShellContextValue.Provider value={{ openNavigation: () => { setOpen(true); }, openSearch: () => { setOpen(false); openPalette(null); }, passwordChange: me.passwordChange }}>
      <div className="min-h-dvh lg:grid lg:h-dvh lg:grid-cols-[234px_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="hidden border-r border-line bg-side lg:block lg:min-h-0 lg:overflow-y-auto">
          <Sidebar me={me} />
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          {/* The drawer scrolls, as the sidebar does: an admin's rows are taller than a phone's screen, and the account menu is the last. */}
          <SheetContent side="left" title={t("shell.navigation")} closeButton={false} className="w-[234px] overflow-y-auto lg:hidden">
            <Sidebar me={me} onNavigate={() => { setOpen(false); }} />
          </SheetContent>
        </Sheet>
        <div className="flex min-h-dvh min-w-0 flex-col lg:min-h-0">
          {children}
        </div>
      </div>
    </ShellContextValue.Provider>
  );
};

/**
 * The panel's frame (app-design.md, Layout): the 234px sidebar beside the page. At phone width the
 * sidebar is a drawer, opened from the top bar. The palette, the shortcuts and the `?` sheet are the
 * shell's (F-081).
 */
export const AppShell = ({ me, children }: { readonly me: RouterOutputs["me"]["get"]; readonly children: ReactNode }) => (
  <StreamProvider>
    <ActionScopeProvider>
      <ShellActions me={me}>
        <Frame me={me}>{children}</Frame>
      </ShellActions>
    </ActionScopeProvider>
  </StreamProvider>
);
