"use client";

import { BellIcon, BookOpenIcon, BoxIcon, ChartNoAxesColumnIcon, ContainerIcon, CheckIcon, ChevronsUpDownIcon, CircleUserRoundIcon, CpuIcon, GitPullRequestIcon, HouseIcon, MailIcon, PlusIcon, HardDriveIcon, ScrollTextIcon, SearchIcon, ServerIcon, SlidersHorizontalIcon, TicketIcon, UsersIcon, WalletIcon } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { useShell } from "./app-shell";
import { NavLink } from "./nav-link";
import { ProjectNav } from "./project-nav";
import { UserMenu } from "./user-menu";

type Me = RouterOutputs["me"]["get"];

const noop = (): void => undefined;

/** A group label: Plex Sans 500 12px `--faint` (graphite.css `.sec`, at the pictures' scale). */
const SectionLabel = ({ children }: { readonly children: string }) => (
  <div className="px-2 pb-1 pt-3.5 text-xs font-medium leading-[1.45] text-faint">{children}</div>
);

/** The organization switcher: the Hinge mark, the organization's name and a chevron. */
const OrganizationSwitcher = ({ me }: { readonly me: Me }) => {
  const name = me.organization?.name ?? t("shell.noOrganization");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sel data-[state=open]:bg-sel"
        aria-label={t("shell.switchOrganization")}
      >
        <img src="/brand/ostra-mark-fit.svg" alt="" width={22} height={22} className="size-[22px] shrink-0" />
        <b className="min-w-0 truncate text-[15px] font-semibold text-text">{name}</b>
        <ChevronsUpDownIcon aria-hidden className="ml-auto size-[14px] shrink-0 stroke-[1.75] text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[212px]">
        <DropdownMenuLabel>{t("shell.organizations")}</DropdownMenuLabel>
        {me.organization === null ? null : (
          <DropdownMenuItem>
            <img src="/brand/ostra-mark-fit.svg" alt="" width={16} height={16} className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{me.organization.name}</span>
            <CheckIcon aria-label={t("shell.current")} className="ml-auto" />
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export type SidebarProps = {
  readonly me: Me;
  readonly onNavigate?: () => void;
};

/**
 * The 234px sidebar (app-targets/m1/README.md, "One sidebar"; graphite.css and shell.js). Milestone 1
 * holds only what works: Home; the projects, each with Tasks and Environment, and New project; the
 * organization's Runners, Models and GitHub. Rows are 28px, type 14.5px, the search box 30px: the
 * approved pictures' scale (app-targets/m1/README.md, "Scale").
 */
export const Sidebar = ({ me, onNavigate = noop }: SidebarProps) => {
  const admin = me.organization?.role === "admin";
  const { openSearch } = useShell();
  const trpc = useTRPC();
  // Ticket 44: what waits on the member, by Home's rule (Home's total, the Open tab's count), kept fresh while the panel is open.
  const waiting = useQuery({ ...trpc.notifications.openCount.queryOptions(), refetchInterval: 10_000 });
  const count = waiting.data?.count ?? 0;

  return (
    <nav aria-label={t("shell.navigation")} className="flex h-full flex-col bg-side px-2.5 py-3">
      <OrganizationSwitcher me={me} />
      <div className="mb-3 mt-2.5 flex gap-1.5">
        <button
          type="button"
          onClick={openSearch}
          className="flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-faint hover:border-line-2 hover:text-muted"
        >
          <SearchIcon aria-hidden className="size-4 shrink-0 stroke-[1.75]" />
          {t("shell.search")}
          <kbd className="ml-auto font-mono text-[11.5px] font-medium text-faint">⌘K</kbd>
        </button>
        <Link
          href="/tasks/new"
          onClick={onNavigate}
          aria-label={t("shell.newTask")}
          title={t("shell.newTask")}
          className="grid size-[30px] shrink-0 place-items-center rounded-md bg-shell text-ink hover:bg-[#e6e2d8]"
        >
          <PlusIcon aria-hidden className="size-4 stroke-[1.75]" />
        </Link>
      </div>

      <NavLink href="/" exact icon={<HouseIcon />} onNavigate={onNavigate}>
        {t("shell.home")}
      </NavLink>
      <NavLink
        href="/needs-you"
        icon={<BellIcon />}
        onNavigate={onNavigate}
        end={count === 0 ? undefined : <span data-testid="needs-you-count" className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-amber px-1 font-mono text-[11px] font-semibold text-ink">{count}</span>}
      >
        {t("needsYouPage.pageTitle")}
      </NavLink>

      <SectionLabel>{t("shell.projects")}</SectionLabel>
      <ProjectNav onNavigate={onNavigate} />
      {admin ? (
        <NavLink href="/projects/new" icon={<PlusIcon />} onNavigate={onNavigate}>
          {t("shell.newProject")}
        </NavLink>
      ) : null}

      <SectionLabel>{t("shell.organization")}</SectionLabel>
      <NavLink href="/organization/runners" also={["/device"]} icon={<ServerIcon />} onNavigate={onNavigate}>
        {t("shell.runners")}
      </NavLink>
      {/* Milestone 5 (box-sizes.md, registry.md): every member reads the sizes; the registry is an admin's. */}
      <NavLink href="/organization/box-sizes" icon={<BoxIcon />} onNavigate={onNavigate}>
        {t("shell.boxSizes")}
      </NavLink>
      {admin ? (
        <NavLink href="/organization/registry" icon={<ContainerIcon />} onNavigate={onNavigate}>
          {t("shell.registry")}
        </NavLink>
      ) : null}
      {admin ? (
        <>
          <NavLink href="/organization/models" icon={<CpuIcon />} onNavigate={onNavigate}>
            {t("shell.models")}
          </NavLink>
          <NavLink href="/organization/github" icon={<GitPullRequestIcon />} onNavigate={onNavigate}>
            {t("shell.github")}
          </NavLink>
          <NavLink href="/organization/linear" icon={<TicketIcon />} onNavigate={onNavigate}>
            {t("shell.linear")}
          </NavLink>
        </>
      ) : null}
      <NavLink href="/organization/agent-profiles" icon={<SlidersHorizontalIcon />} onNavigate={onNavigate}>
        {t("shell.agentProfiles")}
      </NavLink>
      {admin ? (
        <NavLink href="/organization/spend" icon={<WalletIcon />} onNavigate={onNavigate}>
          {t("shell.spend")}
        </NavLink>
      ) : null}
      <NavLink href="/organization/insights" icon={<ChartNoAxesColumnIcon />} onNavigate={onNavigate}>
        {t("shell.insights")}
      </NavLink>
      <NavLink href="/organization/memory" icon={<BookOpenIcon />} onNavigate={onNavigate}>
        {t("shell.memory")}
      </NavLink>
      <NavLink href="/organization/members" icon={<UsersIcon />} onNavigate={onNavigate}>
        {t("shell.members")}
      </NavLink>
      {admin ? (
        <NavLink href="/organization/audit" icon={<ScrollTextIcon />} onNavigate={onNavigate}>
          {t("shell.auditLog")}
        </NavLink>
      ) : null}

      {/* instance-settings.md: the install's own pages, for the instance admin alone (ticket 33). */}
      {me.instanceAdmin ? (
        <>
          <SectionLabel>{t("shell.instance")}</SectionLabel>
          <NavLink href="/instance/accounts" icon={<CircleUserRoundIcon />} onNavigate={onNavigate}>
            {t("shell.accounts")}
          </NavLink>
          <NavLink href="/organization/storage" icon={<HardDriveIcon />} onNavigate={onNavigate}>
            {t("shell.storage")}
          </NavLink>
          <NavLink href="/organization/email" icon={<MailIcon />} onNavigate={onNavigate}>
            {t("shell.email")}
          </NavLink>
        </>
      ) : null}

      <div className="mt-auto pt-3">
        <UserMenu me={me} />
      </div>
    </nav>
  );
};
