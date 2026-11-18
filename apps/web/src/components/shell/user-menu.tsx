"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";

/** The signed-in member at the foot of the sidebar, with sign-out. */
export const UserMenu = ({ me }: { readonly me: RouterOutputs["me"]["get"] }) => {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    await authClient.signOut();
    router.replace("/sign-in");
    router.refresh();
  };
  return (
    <div className="flex items-center gap-[9px] px-2 py-2 text-muted">
      <span className="inline-grid size-[22px] shrink-0 place-items-center rounded-full bg-line-2 text-[10px] font-semibold text-text">
        {initials(me.name)}
      </span>
      <span className="min-w-0 truncate">{me.name}</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void signOut()}
        className="ml-auto rounded-sm p-1 text-faint hover:text-text"
        aria-label={t("shell.signOut")}
        title={t("shell.signOut")}
      >
        <LogOutIcon className="size-[14px]" />
      </button>
    </div>
  );
};
