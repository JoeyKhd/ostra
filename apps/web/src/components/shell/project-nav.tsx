"use client";

import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon, BoxIcon, ChartNoAxesColumnIcon, InboxIcon, ListChecksIcon, LockIcon, SettingsIcon, SquareKanbanIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { NavLink } from "./nav-link";
import { projectColour } from "./project-colour";

/**
 * The member's projects in the sidebar, each with its 8px colour square and a 6px amber dot when
 * something waits on the member there. The open project expands into its pages: Tasks, with the
 * count of its active tasks (every state but stopped, merged and done), and Environment.
 */
export const ProjectNav = ({ onNavigate }: { readonly onNavigate: () => void }) => {
  const trpc = useTRPC();
  const pathname = usePathname();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const openProject = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  return (
    <>
      {projects.data?.map((project) => {
        const open = openProject === project.id;
        return (
          <div key={project.id}>
            <Link
              href={`/projects/${project.id}`}
              onClick={onNavigate}
              className={cn("flex h-7 items-center gap-2.5 whitespace-nowrap rounded-sm px-2 font-medium text-text-2 hover:text-text", open && "text-text")}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />
              <span className="min-w-0 truncate">{project.name}</span>
              {project.access === "restricted" ? <LockIcon aria-label={t("shell.restrictedProject")} className="size-3 shrink-0 stroke-[1.75] text-faint" /> : null}
              {project.needsYouCount > 0 ? (
                <span className="ml-auto size-1.5 rounded-full bg-amber" aria-label={t("shell.needsYouHere", { n: project.needsYouCount })} />
              ) : null}
            </Link>
            {open ? (
              <>
                <NavLink
                  sub
                  exact
                  href={`/projects/${project.id}`}
                  icon={<ListChecksIcon />}
                  onNavigate={onNavigate}
                  {...(project.activeCount > 0
                    ? { end: <span className="font-mono text-xs font-medium text-faint" aria-label={t("shell.activeTasks", { n: project.activeCount })}>{project.activeCount}</span> }
                    : {})}
                >
                  {t("shell.tasks")}
                </NavLink>
                <NavLink
                  sub
                  href={`/projects/${project.id}/inbox`}
                  icon={<InboxIcon />}
                  onNavigate={onNavigate}
                  {...(project.inboxCount > 0
                    ? { end: <span className="font-mono text-xs font-medium text-faint" aria-label={t("shell.inboxCount", { n: project.inboxCount })}>{project.inboxCount}</span> }
                    : {})}
                >
                  {t("shell.inbox")}
                </NavLink>
                <NavLink sub href={`/projects/${project.id}/environment`} icon={<BoxIcon />} onNavigate={onNavigate}>
                  {t("shell.environment")}
                </NavLink>
                <NavLink sub href={`/projects/${project.id}/boards`} icon={<SquareKanbanIcon />} onNavigate={onNavigate}>
                  {t("shell.boards")}
                </NavLink>
                <NavLink sub href={`/projects/${project.id}/memory`} icon={<BookOpenIcon />} onNavigate={onNavigate}>
                  {t("shell.memory")}
                </NavLink>
                <NavLink sub href={`/projects/${project.id}/insights`} icon={<ChartNoAxesColumnIcon />} onNavigate={onNavigate}>
                  {t("shell.insights")}
                </NavLink>
                {/* Every member who can open the project reads its Access tab (F-087); its admins edit. */}
                <NavLink sub href={`/projects/${project.id}/settings`} icon={<SettingsIcon />} onNavigate={onNavigate}>
                  {t("shell.settings")}
                </NavLink>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
};
