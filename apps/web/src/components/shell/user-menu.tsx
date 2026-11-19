"use client";

import { KeyRoundIcon, LogOutIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

/** Up to two initials of a name, for its 22px avatar. */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";

/** The signed-in member at the foot of the sidebar (graphite.css `.bottom`); its menu signs out. */
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
    <DropdownMenu>
      <DropdownMenuTrigger data-testid="user-menu" className="flex w-full items-center gap-[9px] rounded-md p-2 text-left text-muted hover:bg-sel hover:text-text data-[state=open]:bg-sel">
        <span aria-hidden className="inline-grid size-[22px] shrink-0 place-items-center rounded-full bg-line-2 text-[11px] font-semibold text-text">
          {initials(me.name)}
        </span>
        <span className="min-w-0 truncate">{me.name}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[212px]">
        <DropdownMenuLabel className="truncate font-normal">{me.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {me.passwordChange === "none" ? null : (
          <DropdownMenuItem asChild>
            <Link href="/change-password">
              <KeyRoundIcon aria-hidden /> {t("shell.changePassword")}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => {
            void signOut();
          }}
        >
          <LogOutIcon aria-hidden /> {t("shell.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
