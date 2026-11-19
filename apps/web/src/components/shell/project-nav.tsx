"use client";

import { useQuery } from "@tanstack/react-query";
import { BoxIcon, ListChecksIcon } from "lucide-react";
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
                <NavLink sub href={`/projects/${project.id}/environment`} icon={<BoxIcon />} onNavigate={onNavigate}>
                  {t("shell.environment")}
                </NavLink>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
};
