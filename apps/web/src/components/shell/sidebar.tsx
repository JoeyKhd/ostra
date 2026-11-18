"use client";

import { CpuIcon, GitPullRequestIcon, HouseIcon, PlusIcon, ServerIcon } from "lucide-react";
import Link from "next/link";

import { t } from "@/lib/messages";
import type { RouterOutputs } from "@/lib/trpc";

import { NavLink } from "./nav-link";
import { ProjectNav } from "./project-nav";
import { UserMenu } from "./user-menu";

type Me = RouterOutputs["me"]["get"];

const noop = (): void => undefined;

const Section = ({ children }: { readonly children: string }) => (
  <div className="px-2 pb-1 pt-3.5 text-xs font-medium text-faint">{children}</div>
);

export type SidebarProps = {
  readonly me: Me;
  readonly onNavigate?: () => void;
};

/** The 232px sidebar (app-design.md, Layout 1). */
export const Sidebar = ({ me, onNavigate = noop }: SidebarProps) => {
  const admin = me.organization?.role === "admin";

  return (
    <nav aria-label={t("shell.navigation")} className="flex h-full flex-col bg-side px-2.5 py-3">
      <div className="flex items-center gap-[9px] rounded-md px-2 py-1.5">
        <img src="/brand/ostra-mark.svg" alt="" className="size-5" />
        <b className="min-w-0 truncate font-semibold">{me.organization?.name ?? t("shell.noOrganization")}</b>
      </div>
      <div className="mb-3 mt-2.5 flex gap-1.5">
        <Link
          href="/tasks/new"
          onClick={onNavigate}
          className="flex h-7 flex-1 items-center gap-[7px] rounded-md border border-line bg-surface px-2.5 text-muted hover:text-text"
        >
          <PlusIcon className="size-[14px]" />
          {t("shell.newTask")}
        </Link>
      </div>
      <NavLink href="/" exact icon={<HouseIcon />} onNavigate={onNavigate}>
        {t("shell.home")}
      </NavLink>

      <Section>{t("shell.projects")}</Section>
      <ProjectNav onNavigate={onNavigate} />
      {admin ? (
        <NavLink href="/projects/new" icon={<PlusIcon />} onNavigate={onNavigate}>
          {t("shell.newProject")}
        </NavLink>
      ) : null}

      <Section>{t("shell.organization")}</Section>
      <NavLink href="/organization/runners" icon={<ServerIcon />} onNavigate={onNavigate}>
        {t("shell.runners")}
      </NavLink>
      {admin ? (
        <>
          <NavLink href="/organization/models" icon={<CpuIcon />} onNavigate={onNavigate}>
            {t("shell.models")}
          </NavLink>
          <NavLink href="/organization/github" icon={<GitPullRequestIcon />} onNavigate={onNavigate}>
            {t("shell.github")}
          </NavLink>
        </>
      ) : null}

      <div className="mt-auto">
        <UserMenu me={me} />
      </div>
    </nav>
  );
};
