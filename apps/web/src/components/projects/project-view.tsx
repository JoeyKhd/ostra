"use client";

import { useQuery } from "@tanstack/react-query";
import { GitPullRequestIcon, LaptopIcon, ServerIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame, PageHeading } from "@/components/shell/page-frame";
import { NewTaskForm } from "@/components/tasks/new-task-form";
import { doingText, groupText, stateTone, taskStateText } from "@/components/tasks/task-words";
import { Chip, Status } from "@/components/ui/status";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { ProjectProperties } from "./project-properties";

type Group = RouterOutputs["tasks"]["list"][number];
type TaskRow = Group["tasks"][number];

/** Re-renders every so often, so the ages stay true. */
const useNow = (everyMs: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, everyMs);
    return () => { clearInterval(timer); };
  }, [everyMs]);
  return now;
};

const Row = ({ task, now }: { readonly task: TaskRow; readonly now: number }) => (
  <li data-task={task.id} data-state={task.state}>
    <Link href={`/tasks/${task.id}`} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 py-1.5 hover:bg-raise">
      <Status tone={stateTone(task.state)} className="w-28 shrink-0 text-sm">{taskStateText(task.state)}</Status>
      <span className="w-20 shrink-0 font-mono text-sm text-faint">{task.key}</span>
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <span className="hidden min-w-0 max-w-[30%] truncate text-sm text-muted md:inline">{doingText(task.doing) || (task.reason ?? "")}</span>
      <span className="ml-auto flex shrink-0 items-center gap-3 text-sm">
        {task.prs.map((pr) => (
          <span key={pr.number} className="inline-flex items-center gap-1 text-muted"><GitPullRequestIcon className="size-3" />#{pr.number}</span>
        ))}
        {task.runner === null ? null : (
          <span className="hidden items-center gap-1.5 text-muted lg:inline-flex">
            {task.runner.kind === "personal" ? <LaptopIcon className="size-3" /> : <ServerIcon className="size-3" />}
            <span className="font-mono">{task.runner.name}</span>
            {task.runner.isolated ? null : <Chip className="h-[18px] px-1.5 text-[11px] text-amber">{t("runners.notIsolated")}</Chip>}
          </span>
        )}
        {task.driver === null ? null : <span className="hidden text-muted sm:inline">{task.driver.name}</span>}
        <span className="w-9 text-right font-mono text-faint">{formatAge(task.createdAt, now)}</span>
      </span>
    </Link>
  </li>
);

/**
 * A project's tasks (ticket 38): grouped by state in the domain model's order, a count per group,
 * and the "New task" composer with "Run on".
 */
export const ProjectView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const groups = useQuery(trpc.tasks.list.queryOptions({ projectId }));
  const now = useNow(30_000);
  const total = groups.data?.reduce((sum, group) => sum + group.tasks.length, 0) ?? 0;

  return (
    <PageFrame
      crumbs={[{ label: project.data?.name ?? "" }, { label: t("shell.tasks") }]}
      properties={project.data === undefined ? undefined : <ProjectProperties project={project.data} />}
    >
      {project.error === null ? null : <p role="alert" className="text-red">{errorText(project.error)}</p>}
      {project.data === undefined ? null : (
        <PageHeading title={project.data.name} lede={project.data.repos.map((repo) => repo.fullName).join(", ")} />
      )}
      <div className="mt-5">
        <NewTaskForm projectId={projectId} compact />
      </div>
      {groups.error === null ? null : <p role="alert" className="mt-4 text-red">{errorText(groups.error)}</p>}
      {groups.data !== undefined && total === 0 ? <p className="mt-6 text-muted">{t("tasks.none")}</p> : null}
      <div className="mt-6" data-testid="task-groups">
        {groups.data
          ?.filter((group) => group.tasks.length > 0)
          .map((group) => (
            <section key={group.group} data-group={group.group} className="mb-5">
              <h2 className="flex h-8 items-center gap-2 rounded-sm bg-surface px-2 text-sm font-medium">
                {group.group === "needs-you" ? <span aria-hidden className="size-[7px] rounded-full bg-amber" /> : null}
                {groupText(group.group)}
                <span className="font-mono text-faint">{group.tasks.length}</span>
              </h2>
              <ul className="rows">
                {group.tasks.map((task) => <Row key={task.id} task={task} now={now} />)}
              </ul>
            </section>
          ))}
      </div>
    </PageFrame>
  );
};
