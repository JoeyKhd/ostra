"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";

/**
 * A project's settings tabs (project-access.md, "Settings tabs"): links, so the URL carries the tab.
 * A project admin sees every tab; a project member `Models and keys` and `Access`, read-only
 * (F-135: `Models and keys` sits between `Repos` and `Access`, ticket 53).
 */
export const ProjectSettingsTabs = ({ projectId, admin }: { readonly projectId: string; readonly admin: boolean }) => {
  const pathname = usePathname();
  const base = `/projects/${projectId}`;
  const tabs = [
    ...(admin ? [{ href: `${base}/settings/ticket-template`, label: t("projectSettings.ticketTemplate") }, { href: `${base}/settings/repos`, label: t("projectSettings.repos") }] : []),
    { href: `${base}/settings/models`, label: t("projectSettings.models") },
    { href: `${base}/settings/access`, label: t("projectSettings.access") },
    // Milestone 5 (project-runners.md): the pools and shares are an admin's settings.
    ...(admin ? [{ href: `${base}/settings/runners`, label: t("projectSettings.runners") }, { href: `${base}/settings/audit`, label: t("projectSettings.audit") }] : []),
  ];
  return (
    <nav aria-label={t("projectSettings.tabs")} className="-mt-1 mb-6 flex gap-6 overflow-x-auto border-b border-line">
      {tabs.map((tab) => {
        const current = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={cn("-mb-px shrink-0 border-b-2 pb-2 pt-1 text-ui font-medium", current ? "border-text text-text" : "border-transparent text-muted hover:text-text")}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
};
