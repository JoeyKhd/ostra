"use client";

import { BellIcon, KeyRoundIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { themePreferences } from "@ostra/domain/theme";
import type { ThemePreference } from "@ostra/domain/theme";

import { themeLabel } from "@/components/account/theme-choice";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { useTheme } from "./theme-provider";

/** Up to two initials of a name, for its 22px avatar. */
export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";

const themeIcon = (theme: ThemePreference) => {
  switch (theme) {
    case "dark":
      return <MoonIcon aria-hidden />;
    case "light":
      return <SunIcon aria-hidden />;
    case "system":
      return <MonitorIcon aria-hidden />;
    default:
      return theme satisfies never;
  }
};

const isTheme = (value: string): value is ThemePreference => themePreferences.some((theme) => theme === value);

/** The member menu's quick theme toggle (account-appearance.md, "The sidebar's quick toggle"). */
const ThemeSubmenu = () => {
  const { theme, choose } = useTheme();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="theme-menu">
        {themeIcon(theme)} {t("shell.theme")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) choose(value);
          }}
        >
          {themePreferences.map((choice) => (
            <DropdownMenuRadioItem key={choice} value={choice}>
              {themeIcon(choice)} {themeLabel(choice)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};

/**
 * The signed-in member at the foot of the rail (app-shell.md, "The account"): their initials in a
 * 28px circle (a 44px target in the phone sheet); its menu holds the theme, the account and sign out.
 */
export const UserMenu = ({ me, sheet = false, tabIndex, onFocus }: { readonly me: RouterOutputs["me"]["get"]; readonly sheet?: boolean; readonly tabIndex?: number; readonly onFocus?: () => void }) => {
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
      {/* No tooltip in the phone's sheet: a touch has no hover, and Escape there is the sheet's. */}
      <Tooltip content={me.name} side="right" delay={500} suppressed={sheet}>
        <DropdownMenuTrigger
          data-testid="user-menu"
          data-roving-item=""
          aria-label={t("shell.rail.account", { name: me.name })}
          {...(tabIndex === undefined ? {} : { tabIndex })}
          {...(onFocus === undefined ? {} : { onFocus })}
          className={cn("grid shrink-0 place-items-center rounded-full", sheet ? "size-11" : "size-9")}
        >
          <span aria-hidden className="rail-avatar inline-grid size-7 place-items-center rounded-full text-[11px] font-semibold text-text">
            {initials(me.name)}
          </span>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="w-[212px]">
        <DropdownMenuLabel className="truncate font-normal">{me.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <ThemeSubmenu />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserIcon aria-hidden /> {t("shell.account")}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/account/notifications">
            <BellIcon aria-hidden /> {t("shell.notifications")}
          </Link>
        </DropdownMenuItem>
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
