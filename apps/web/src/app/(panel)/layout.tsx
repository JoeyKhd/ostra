import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { getServerApi } from "@/server/api";

/**
 * Every panel route guards on the session: no session, no panel. An account that still has its
 * seeded default password chooses a new one first (F-001), unless the install allows it.
 */
const PanelLayout = async ({ children }: { readonly children: ReactNode }) => {
  const { caller, signedIn } = await getServerApi();
  const path = (await headers()).get("x-ostra-path") ?? "/";
  if (!signedIn) {
    redirect(path === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(path)}`);
  }
  const me = await caller.me.get();
  if (me.passwordChange === "required") {
    redirect(path === "/" ? "/change-password" : `/change-password?next=${encodeURIComponent(path)}`);
  }
  return <AppShell me={me}>{children}</AppShell>;
};

export default PanelLayout;
