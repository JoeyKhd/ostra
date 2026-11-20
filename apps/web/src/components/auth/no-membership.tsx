"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";

/**
 * F-002 (ADR 0053; spec m4 section 3, step 14): an account with no active membership, such as a
 * member an admin removed, sees why the panel opens nothing, instead of pages that can't load.
 */
export const NoMembership = ({ email, reason }: { readonly email: string; readonly reason: "removed" | "none" }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  };
  return (
    <div data-testid="no-membership" data-reason={reason}>
      <h1 className="page-title text-text">{t(reason === "removed" ? "noMembership.title" : "noMembership.noneTitle")}</h1>
      <p className="mt-[3px] text-lede text-muted">{t(reason === "removed" ? "noMembership.lede" : "noMembership.noneLede")}</p>
      <p className="mt-[20px] text-[12px] leading-[18px] text-faint">{t("noMembership.signedInAs", { email })}</p>
      <Button type="button" variant="outline" size="xl" className="mt-[12px] w-full" disabled={busy} onClick={() => void signOut()}>
        {t("noMembership.signOut")}
      </Button>
    </div>
  );
};
