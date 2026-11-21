"use client";

import { CheckIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

import { isMac } from "./actions/kbd-sequence";
import type { Space } from "./places";
import { rovingKeyDown } from "./roving";
import { ShellIconView } from "./shell-icons";
import type { ShellIcon } from "./places";
import { useShellState } from "./shell-state";
import { UserMenu } from "./user-menu";

/** The four spaces of the rail's middle, in the targets' order; Settings sits in its foot. */
const railSpaces = [
  { space: "home", icon: "house", label: "shell.rail.home", name: "shell.home", tip: "shell.rail.homeTip" },
  { space: "needs-you", icon: "bell", label: "shell.rail.needsYou", name: "needsYouPage.pageTitle", tip: "shell.rail.needsYouTip" },
  { space: "projects", icon: "folder", label: "shell.rail.projects", name: "shell.projects", tip: "shell.rail.projectsTip" },
  { space: "organization", icon: "building-2", label: "shell.rail.org", name: "shell.organization", tip: "shell.rail.orgTip" },
] as const satisfies readonly { readonly space: Space; readonly icon: ShellIcon; readonly label: string; readonly name: string; readonly tip: string }[];

/** The rail's items, top to bottom, for its one tab stop. */
type RailItem = "organization-tile" | "new-task" | "search" | Space | "account";

export type RailProps = {
  /** In the phone sheet: touch sizes, and a tap on a space closes the sheet. */
  readonly sheet?: boolean;
  readonly onNavigate?: () => void;
  readonly onSearch: () => void;
};

/** The organization tile: the Hinge, 24px in a 40px tile; its menu is today's switcher. */
const OrganizationTile = ({ sheet, tabIndex, onFocus }: { readonly sheet: boolean; readonly tabIndex: number; readonly onFocus: () => void }) => {
  const shell = useShellState();
  const organization = shell.me.organization;
  const name = organization?.name ?? t("shell.noOrganization");
  return (
    <DropdownMenu>
      <Tooltip content={name} side="right" delay={500} suppressed={sheet}>
        <DropdownMenuTrigger
          data-roving-item=""
          tabIndex={tabIndex}
          onFocus={onFocus}
          aria-label={t("shell.switchOrganization", { name })}
          className={cn("relative grid shrink-0 place-items-center rounded-[9px] hover:bg-hover data-[state=open]:bg-sel", sheet ? "size-11" : "size-10")}
        >
          <span aria-hidden className="logo-mark size-6" />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" className="w-[212px]">
        <DropdownMenuLabel>{t("shell.organizations")}</DropdownMenuLabel>
        {organization === null ? null : (
          <DropdownMenuItem>
            <span aria-hidden className="logo-mark size-4 shrink-0" />
            <span className="min-w-0 truncate">{organization.name}</span>
            <CheckIcon aria-label={t("shell.current")} className="ml-auto" />
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** A tool of the rail (Search, Settings): a 36×34 target, an 18px `--muted` icon (44px in the sheet). */
const toolClass = (sheet: boolean, lit = false): string =>
  cn("grid shrink-0 place-items-center rounded-lg text-muted hover:bg-hover hover:text-text [&_svg]:size-[18px] [&_svg]:stroke-[1.75]", sheet ? "size-11" : "h-[34px] w-9", lit && "bg-sel text-text hover:bg-sel");

/**
 * The rail (app-shell.md, "The rail"): 64px on `--side`, the organization tile, New task, Search,
 * the four spaces with Needs you's amber count, then Settings and the account. One landmark and one
 * tab stop: ↑ and ↓ move through it, Home and End jump to its ends. Each item has a tooltip and an
 * accessible name, and the open space is marked. Resting the pointer on a space while the panel is
 * collapsed peeks at its panel.
 */
export const Rail = ({ sheet = false, onNavigate, onSearch }: RailProps) => {
  const shell = useShellState();
  const navigate = onNavigate ?? (() => undefined);
  const [stop, setStop] = useState<RailItem | null>(null);
  // The tab stop: the item that last had the focus, else the open space.
  const current: RailItem = stop ?? shell.space;
  const tab = (item: RailItem): number => (item === current ? 0 : -1);
  const peekable = !sheet && shell.band !== null && shell.band !== "phone" && !shell.shown;
  const count = shell.needsYou;
  const searchKeys = isMac() ? "⌘K" : "Ctrl K";

  const spaceLink = (entry: (typeof railSpaces)[number]): ReactNode => {
    const lit = shell.space === entry.space;
    const waiting = entry.space === "needs-you" && count !== null && count > 0 ? count : null;
    return (
      <Tooltip key={entry.space} content={t(entry.tip)} side="right" delay={500} suppressed={sheet || shell.peek !== null}>
        <Link
          href={shell.spaceHref(entry.space)}
          data-roving-item=""
          data-space={entry.space}
          tabIndex={tab(entry.space)}
          onFocus={() => { setStop(entry.space); }}
          onClick={navigate}
          onPointerEnter={(event) => { if (peekable && event.pointerType === "mouse") shell.peekControl.enter(entry.space); }}
          aria-label={waiting === null ? t(entry.name) : t("shell.rail.needsYouCount", { n: waiting })}
          aria-current={lit ? "page" : undefined}
          className={cn(
            "relative flex shrink-0 flex-col items-center justify-center gap-[3px] rounded-[9px] text-faint hover:bg-hover hover:text-text-2 [&_svg]:size-[19px] [&_svg]:stroke-[1.75]",
            sheet ? "h-[52px] w-[54px]" : "h-[50px] w-[54px]",
            lit && "bg-sel text-text hover:bg-sel hover:text-text",
            !lit && shell.peek === entry.space && "bg-hover text-text-2",
          )}
        >
          <ShellIconView name={entry.icon} />
          <span aria-hidden className="whitespace-nowrap text-[11px] font-medium leading-[13px] tracking-[0.005em]">{t(entry.label)}</span>
          {waiting === null ? null : (
            <span
              aria-hidden
              data-testid="needs-you-count"
              className={cn(
                "absolute right-1.5 top-[3px] h-[17px] min-w-[17px] rounded-full bg-amber px-1 text-center font-mono text-[10.5px] font-semibold leading-[17px] text-on-amber",
                lit ? "shadow-[0_0_0_2px_var(--sel)]" : "shadow-[0_0_0_2px_var(--side)]",
              )}
            >
              {waiting}
            </span>
          )}
        </Link>
      </Tooltip>
    );
  };

  return (
    <nav
      aria-label={t("shell.rail.label")}
      data-shell-rail=""
      onKeyDownCapture={rovingKeyDown(true)}
      onPointerLeave={() => { if (peekable) shell.peekControl.leave(); }}
      className={cn("flex h-full w-16 shrink-0 flex-col items-center gap-0.5 bg-side", sheet ? "pb-2.5 pt-[5px]" : "border-r border-line pb-3 pt-2")}
    >
      <OrganizationTile sheet={sheet} tabIndex={tab("organization-tile")} onFocus={() => { setStop("organization-tile"); }} />
      <Tooltip content={t("shell.rail.newTaskTip")} side="right" delay={500} suppressed={sheet}>
        <Link
          href="/tasks/new"
          data-roving-item=""
          tabIndex={tab("new-task")}
          onFocus={() => { setStop("new-task"); }}
          onClick={navigate}
          aria-label={t("shell.newTask")}
          className={cn("grid shrink-0 place-items-center bg-primary text-on-primary hover:bg-primary/88", sheet ? "my-1 size-9 rounded-lg" : "mt-1 size-8 rounded-[7px]")}
        >
          <PlusIcon aria-hidden className="size-[17px] stroke-2" />
        </Link>
      </Tooltip>
      <Tooltip content={t("shell.rail.searchTip", { keys: searchKeys })} side="right" delay={500} suppressed={sheet}>
        <button
          type="button"
          data-roving-item=""
          data-action="open-palette"
          tabIndex={tab("search")}
          onFocus={() => { setStop("search"); }}
          onClick={onSearch}
          aria-label={t("shell.search")}
          className={toolClass(sheet)}
        >
          <SearchIcon aria-hidden />
        </button>
      </Tooltip>
      <div aria-hidden className="mb-[7px] mt-[9px] h-px w-7 shrink-0 bg-line" />
      {railSpaces.map(spaceLink)}
      <div className="mt-auto flex flex-col items-center gap-1.5 pt-2">
        <Tooltip content={t("shell.settings")} side="right" delay={500} suppressed={sheet}>
          <Link
            href={shell.spaceHref("settings")}
            data-roving-item=""
            data-space="settings"
            tabIndex={tab("settings")}
            onFocus={() => { setStop("settings"); }}
            onClick={navigate}
            aria-label={t("shell.settings")}
            aria-current={shell.space === "settings" ? "page" : undefined}
            className={toolClass(sheet, shell.space === "settings")}
          >
            <SettingsIcon aria-hidden />
          </Link>
        </Tooltip>
        <UserMenu me={shell.me} sheet={sheet} tabIndex={tab("account")} onFocus={() => { setStop("account"); }} />
      </div>
    </nav>
  );
};
