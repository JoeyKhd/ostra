import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { getServerApi } from "@/server/api";

/** Every panel route guards on the session: no session, no panel. */
const PanelLayout = async ({ children }: { readonly children: ReactNode }) => {
  const { caller, signedIn } = await getServerApi();
  if (!signedIn) {
    const state = await caller.setup.state();
    const path = (await headers()).get("x-ostra-path") ?? "/";
    redirect(state.needsFirstAdmin ? "/setup" : path === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(path)}`);
  }
  const me = await caller.me.get();
  return <AppShell me={me}>{children}</AppShell>;
};

export default PanelLayout;
