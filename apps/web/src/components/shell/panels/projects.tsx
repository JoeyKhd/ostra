"use client";

import { useQuery } from "@tanstack/react-query";
import { LockIcon, PlusIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";

import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import type { PanelMode } from "../context-panel";
import { HeadButton, PanelFrame, PanelTitle } from "../context-panel";
import { LiveFailed, LiveSkeleton } from "../live-task-row";
import { NavLink, RowCount } from "../nav-link";
import { projectColour } from "../project-colour";
import { useShellState } from "../shell-state";

type Project = RouterOutputs["projects"]["list"][number];

/** Needs-you ones first, then the list's order. */
export const byNeedsYou = (projects: readonly Project[]): readonly Project[] =>
  projects.map((project, at) => ({ project, at })).sort((a, b) => Number(b.project.needsYouCount > 0) - Number(a.project.needsYouCount > 0) || a.at - b.at).map(({ project }) => project);

/** A project's row: its 9px square, its name, a lock when restricted, and an amber dot where something waits on the member. */
export const ProjectRowLink = ({ project, onNavigate, end }: { readonly project: Project; readonly onNavigate: () => void; readonly end?: ReactNode }) => (
  <NavLink
    href={`/projects/${project.id}`}
    current={false}
    icon={<span aria-hidden className="size-[9px] shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />}
    end={
      <>
        {project.access === "restricted" ? <LockIcon aria-label={t("shell.restrictedProject")} className="size-3! text-faint" /> : null}
        {project.needsYouCount > 0 ? <span aria-label={t("shell.needsYouHere", { n: project.needsYouCount })} className="size-1.5 rounded-full bg-amber shadow-(--dot-amber)" /> : null}
        {end}
      </>
    }
    onNavigate={onNavigate}
  >
    {project.name}
  </NavLink>
);

/**
 * The Projects space with no project open (app-shell.md, "With no project open"): a filter, then
 * every project the member can open, needs-you ones first, with their running count.
 */
export const ProjectsPanel = ({ mode, onNavigate }: { readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const shell = useShellState();
  const admin = shell.me.organization?.role === "admin";
  const projects = useQuery(trpc.projects.list.queryOptions());
  const [filter, setFilter] = useState("");
  const words = filter.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const shown = byNeedsYou(projects.data ?? []).filter((project) => words.every((word) => project.name.toLowerCase().includes(word)));
  const title = t("shell.projects");
  return (
    <PanelFrame
      mode={mode}
      label={title}
      title={<PanelTitle>{title}</PanelTitle>}
      actions={
        admin ? (
          <HeadButton label={t("shell.newProject")} onClick={() => { onNavigate(); router.push("/projects/new"); }}>
            <PlusIcon aria-hidden />
          </HeadButton>
        ) : null
      }
    >
      {projects.isPending ? (
        <LiveSkeleton />
      ) : projects.isError ? (
        <LiveFailed retry={() => { void projects.refetch(); }} />
      ) : projects.data.length === 0 ? (
        <p className="px-2 py-1 text-sm text-faint">
          {t("shell.panel.noProjects")}{" "}
          {admin ? (
            <Link href="/projects/new" onClick={onNavigate} className="text-teal hover:underline">
              {t("shell.newProject")}
            </Link>
          ) : (
            t("shell.panel.askAdmin")
          )}
        </p>
      ) : (
        <>
          <label className="focus-box mb-1.5 mt-0.5 flex h-[30px] items-center gap-2 rounded-sm border border-control-line bg-surface px-[9px] text-faint">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 stroke-[1.75]" />
            <input
              value={filter}
              onChange={(event) => { setFilter(event.target.value); }}
              placeholder={t("shell.panel.filterProjects")}
              aria-label={t("shell.panel.filterProjects")}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-text outline-none placeholder:text-faint focus-visible:outline-none"
            />
          </label>
          {shown.map((project) => (
            <ProjectRowLink
              key={project.id}
              project={project}
              onNavigate={onNavigate}
              {...(project.runningCount > 0 ? { end: <RowCount n={project.runningCount} label={t("shell.panel.runningCount", { n: project.runningCount })} /> } : {})}
            />
          ))}
        </>
      )}
    </PanelFrame>
  );
};
