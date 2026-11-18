"use client";

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { Sidebar } from "./sidebar";

type ShellContext = { readonly openNavigation: () => void };

const ShellContextValue = createContext<ShellContext>({ openNavigation: () => undefined });

/** Lets the top bar open the sidebar drawer at phone width. */
export const useShell = (): ShellContext => useContext(ShellContextValue);

/**
 * The panel's frame (app-design.md, Layout): the 232px sidebar beside the page. At phone width the
 * sidebar is a drawer, opened from the top bar.
 */
export const AppShell = ({ me, children }: { readonly me: RouterOutputs["me"]["get"]; readonly children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <ShellContextValue.Provider value={{ openNavigation: () => { setOpen(true); } }}>
      <div className="min-h-dvh lg:grid lg:h-dvh lg:grid-cols-[232px_minmax(0,1fr)] lg:overflow-hidden">
        <aside className="hidden border-r border-line lg:block lg:min-h-0 lg:overflow-y-auto">
          <Sidebar me={me} />
        </aside>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="left" title={t("shell.navigation")} className="w-[232px] lg:hidden">
            <Sidebar me={me} onNavigate={() => { setOpen(false); }} />
          </SheetContent>
        </Sheet>
        <div className="flex min-h-dvh min-w-0 flex-col lg:min-h-0">{children}</div>
      </div>
    </ShellContextValue.Provider>
  );
};
