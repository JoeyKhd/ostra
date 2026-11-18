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
 * The member's projects in the sidebar, each with its 8px colour square and an amber dot when
 * something waits on the member there. The open project expands into its pages.
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
              className={cn("flex h-[26px] items-center gap-[9px] rounded-sm px-2 font-medium text-muted hover:text-text", open && "text-text")}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />
              <span className="min-w-0 truncate">{project.name}</span>
              {project.needsYouCount > 0 ? (
                <span className="ml-auto size-1.5 rounded-full bg-amber" aria-label={t("shell.needsYouHere", { n: project.needsYouCount })} />
              ) : null}
            </Link>
            {open ? (
              <>
                <NavLink sub exact href={`/projects/${project.id}`} icon={<ListChecksIcon />} onNavigate={onNavigate}>
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
