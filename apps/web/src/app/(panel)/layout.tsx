import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AuthFrame } from "@/components/auth/auth-frame";
import { NoMembership } from "@/components/auth/no-membership";
import { AppShell } from "@/components/shell/app-shell";
import { SIDEBAR_COOKIE, readSidebarCookie } from "@/components/shell/sidebar-state";
import { getServerApi } from "@/server/api";

/**
 * Every panel route guards on the session: no session, no panel. An account that still has its
 * seeded default password chooses a new one first (F-001), unless the install allows it. An account
 * with no active membership sees why the panel opens nothing (F-002).
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
  // F-002 (ADR 0053): an account with no active membership, a removed member's, opens nothing but
  // this page; the instance admin keeps the install's own pages.
  const instancePage = path.startsWith("/instance") || path.startsWith("/account");
  if (me.noMembership !== null && !(me.instanceAdmin && instancePage)) {
    return (
      <AuthFrame>
        <NoMembership email={me.email} reason={me.noMembership} />
      </AuthFrame>
    );
  }
  // F-147: the context panel as the member left it, read here so the first frame draws it (no flash).
  const sidebar = readSidebarCookie((await cookies()).get(SIDEBAR_COOKIE)?.value);
  return (
    <AppShell me={me} sidebar={sidebar}>
      {children}
    </AppShell>
  );
};

export default PanelLayout;
