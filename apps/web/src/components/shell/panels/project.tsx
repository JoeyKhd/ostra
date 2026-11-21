"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon, EllipsisIcon, ListFilterIcon, LockIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import type { PanelMode } from "../context-panel";
import { HeadButton, PanelFrame } from "../context-panel";
import { LiveFailed, LiveSkeleton, LiveTaskRow } from "../live-task-row";
import { projectLive } from "../live-tasks";
import { AmberCount, NavLink, RowCount, SectionLabel, useDensity } from "../nav-link";
import { projectRows } from "../places";
import type { ProjectRow } from "../places";
import { projectColour } from "../project-colour";
import { otherProjects, readRecentProjects } from "../recent";
import { ShellIconView } from "../shell-icons";
import { useShellState } from "../shell-state";
import { byNeedsYou, ProjectRowLink } from "./projects";

type Project = RouterOutputs["projects"]["list"][number];

/** How many live tasks show before `{n} more`. */
const LIVE_SHOWN = 8;

const MINE_KEY = "ostra.live-mine";

const readMine = (): boolean => {
  try {
    return window.localStorage.getItem(MINE_KEY) === "1";
  } catch {
    return false;
  }
};

const writeMine = (mine: boolean): void => {
  try {
    window.localStorage.setItem(MINE_KEY, mine ? "1" : "0");
  } catch {
    // Not kept: the list shows everyone's next time.
  }
};

/** The switcher's menu: the member's projects, needs-you ones first, and New project for an admin. */
const SwitcherMenu = ({ trigger, projects, admin, onNavigate }: { readonly trigger: ReactNode; readonly projects: readonly Project[]; readonly admin: boolean; readonly onNavigate: () => void }) => (
  <DropdownMenu>
    {trigger}
    <DropdownMenuContent align="start" className="max-h-[min(420px,70vh)] w-[240px] overflow-y-auto">
      <DropdownMenuLabel>{t("shell.projects")}</DropdownMenuLabel>
      {byNeedsYou(projects).map((project) => (
        <DropdownMenuItem key={project.id} asChild>
          <Link href={`/projects/${project.id}`} onClick={onNavigate}>
            <span aria-hidden className="size-[9px] shrink-0 rounded-[2px]" style={{ background: projectColour(project.id) }} />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.access === "restricted" ? <LockIcon aria-label={t("shell.restrictedProject")} className="size-3!" /> : null}
            {project.needsYouCount > 0 ? <span aria-label={t("shell.needsYouHere", { n: project.needsYouCount })} className="size-1.5 rounded-full bg-amber shadow-(--dot-amber)" /> : null}
          </Link>
        </DropdownMenuItem>
      ))}
      {admin ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/projects/new" onClick={onNavigate}>
              <PlusIcon aria-hidden />
              {t("shell.newProject")}
            </Link>
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  </DropdownMenu>
);

/**
 * A project's panel (app-shell.md, "With a project open"): the switcher in its head, the project's
 * pages with their counts, its live tasks (every driver's, or the member's own), and the member's
 * other projects with their amber dots.
 */
export const ProjectPanel = ({ projectId, mode, onNavigate }: { readonly projectId: string; readonly mode: PanelMode; readonly onNavigate: () => void }) => {
  const trpc = useTRPC();
  const router = useRouter();
  const shell = useShellState();
  const density = useDensity();
  const admin = shell.me.organization?.role === "admin";
  const projects = useQuery(trpc.projects.list.queryOptions());
  const project = projects.data?.find((one) => one.id === projectId) ?? null;
  // F-040: the tasks waiting for a member's approval, counted per project for the amber pill.
  const approvals = useQuery({ ...trpc.tasks.needsApproval.queryOptions({ projectId: null }), refetchInterval: 30_000 });
  const waiting = approvals.data === undefined ? null : approvals.data.tasks.filter((task) => task.project.id === projectId).length;
  const tasks = useQuery({ ...trpc.tasks.list.queryOptions({ projectId: project?.id ?? projectId }), enabled: project !== null });
  const [mine, setMine] = useState(false);
  useEffect(() => { setMine(readMine()); }, []);
  const live = tasks.data === undefined ? [] : projectLive(tasks.data, mine ? shell.me.memberId : null);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const organizationId = shell.organizationId;
  useEffect(() => {
    if (organizationId !== null) setRecent(readRecentProjects(organizationId));
  }, [organizationId, projectId]);
  const others = otherProjects(projects.data ?? [], recent, projectId);
  const row = shell.place.space === "projects" && shell.place.projectId === projectId ? shell.place.row : null;
  const name = project?.name ?? "";

  const counts = (id: ProjectRow): ReactNode => {
    if (project === null) return undefined;
    switch (id) {
      case "tasks":
        return project.activeCount > 0 ? <RowCount n={project.activeCount} label={t("shell.activeTasks", { n: project.activeCount })} /> : undefined;
      case "needs-approval":
        return waiting !== null && waiting > 0 ? <AmberCount n={waiting} label={t("shell.needsApprovalCount", { n: waiting })} testId="needs-approval-count" /> : undefined;
      case "inbox":
        return project.inboxCount > 0 ? <RowCount n={project.inboxCount} label={t("shell.inboxCount", { n: project.inboxCount })} /> : undefined;
      case "boards":
      case "environment":
      case "automations":
      case "memory":
      case "insights":
      case "settings":
        return undefined;
      default:
        return id satisfies never;
    }
  };

  const switcher = (
    <SwitcherMenu
      projects={projects.data ?? []}
      admin={admin}
      onNavigate={onNavigate}
      trigger={
        <DropdownMenuTrigger
          aria-label={t("shell.panel.switchProject", { project: name })}
          className={cn("-ml-1.5 flex h-[30px] min-w-0 items-center gap-2 rounded-sm px-1.5 text-left hover:bg-hover data-[state=open]:bg-sel", density === "sheet" && "h-11")}
        >
          <span aria-hidden className="size-[9px] shrink-0 rounded-[2px]" style={{ background: projectColour(projectId) }} />
          <span className={cn("min-w-0 truncate font-semibold text-text", density === "sheet" ? "text-base" : "text-[15px]")}>{name}</span>
          <ChevronsUpDownIcon aria-hidden className="size-3.5 shrink-0 stroke-[1.75] text-faint" />
        </DropdownMenuTrigger>
      }
    />
  );

  return (
    <PanelFrame
      mode={mode}
      label={name === "" ? t("shell.projects") : name}
      title={switcher}
      actions={
        <HeadButton label={t("shell.panel.newTaskIn", { project: name })} onClick={() => { onNavigate(); router.push(`/tasks/new?project=${encodeURIComponent(projectId)}`); }}>
          <PlusIcon aria-hidden />
        </HeadButton>
      }
    >
      {projectRows(projectId).map((entry) => {
        const end = counts(entry.id);
        return (
          <NavLink key={entry.id} href={entry.href} icon={<ShellIconView name={entry.icon} />} current={row === entry.id} onNavigate={onNavigate} {...(end === undefined ? {} : { end })}>
            {t(entry.label)}
          </NavLink>
        );
      })}

      <SectionLabel
        {...(tasks.data === undefined ? {} : { count: live.length })}
        end={
          <button
            type="button"
            aria-pressed={mine}
            aria-label={mine ? t("shell.panel.showEveryone") : t("shell.panel.showMine")}
            title={mine ? t("shell.panel.showEveryone") : t("shell.panel.showMine")}
            onClick={() => { setMine(!mine); writeMine(!mine); }}
            className={cn("grid size-6 place-items-center rounded-sm hover:bg-hover hover:text-text", mine ? "text-text" : "text-faint")}
          >
            <ListFilterIcon aria-hidden className="size-3.5 stroke-[1.75]" />
          </button>
        }
      >
        {mine ? t("shell.panel.liveMine") : t("shell.panel.live")}
      </SectionLabel>
      {tasks.isPending ? (
        <LiveSkeleton />
      ) : tasks.isError ? (
        <LiveFailed retry={() => { void tasks.refetch(); }} />
      ) : live.length === 0 ? (
        <p className="px-2 py-1 text-sm text-faint">{t("shell.panel.noLive", { project: name })}</p>
      ) : (
        <>
          {live.slice(0, LIVE_SHOWN).map((task) => (
            <LiveTaskRow key={task.taskId} task={task} onNavigate={onNavigate} />
          ))}
          {live.length > LIVE_SHOWN ? (
            <NavLink href={`/projects/${projectId}`} current={false} onNavigate={onNavigate}>
              {t("shell.panel.more", { n: live.length - LIVE_SHOWN })}
            </NavLink>
          ) : null}
        </>
      )}

      {others.length === 0 ? null : (
        <>
          <SectionLabel>{t("shell.panel.otherProjects")}</SectionLabel>
          {others.map((other) => (
            <ProjectRowLink key={other.id} project={other} onNavigate={onNavigate} />
          ))}
          {(projects.data?.length ?? 0) > others.length + 1 ? (
            <SwitcherMenu
              projects={projects.data ?? []}
              admin={admin}
              onNavigate={onNavigate}
              trigger={
                <DropdownMenuTrigger
                  data-roving-item=""
                  className={cn("flex w-full items-center rounded-sm font-medium text-text-2 hover:bg-hover hover:text-text data-[state=open]:bg-sel", density === "sheet" ? "h-11 gap-3 px-2.5 text-[15px]" : "h-7 gap-2.5 px-2 text-ui")}
                >
                  <EllipsisIcon aria-hidden className={cn("shrink-0 stroke-[1.75] text-faint", density === "sheet" ? "size-[18px]" : "size-4")} />
                  {t("shell.panel.allProjects", { n: projects.data?.length ?? 0 })}
                </DropdownMenuTrigger>
              }
            />
          ) : null}
        </>
      )}
    </PanelFrame>
  );
};
