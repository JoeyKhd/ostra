"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LaptopIcon,
  LoaderCircleIcon,
  ServerIcon,
  SquareIcon,
} from "lucide-react";
import Link from "next/link";
import { Collapsible } from "radix-ui";
import { Fragment, useEffect, useState } from "react";

import type { ProjectId } from "@ostra/protocol";

import { PageFrame } from "@/components/shell/page-frame";
import { groupText, taskStateText } from "@/components/tasks/task-words";
import type { TaskGroup } from "@/components/tasks/task-words";
import { Avatar } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { ProjectComposer } from "./project-composer";
import { ProjectProperties } from "./project-properties";
import { doingNow, ledeCounts, taskMark } from "./task-row-words";
import type { Segment, TaskMark, TaskRow } from "./task-row-words";

type Group = RouterOutputs["tasks"]["list"][number];

/** Re-renders every so often, so the ages stay true. */
const useNow = (everyMs: number): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, everyMs);
    return () => { clearInterval(timer); };
  }, [everyMs]);
  return now;
};

/** One grid for every row of every group, so the columns line up (project.md, "Wrong in the image"). */
const rowGrid =
  "grid items-center grid-cols-[28px_88px_minmax(0,1fr)_40px] md:grid-cols-[28px_84px_minmax(0,30fr)_minmax(0,26fr)_120px_22px_44px]";

const markIcon = "size-[13px] stroke-[1.75]";
const bandIcon = "size-[15px] stroke-[1.75]";

const Mark = ({ mark }: { readonly mark: TaskMark }) => {
  switch (mark) {
    case "amber":
      return <Dot tone="amber" />;
    case "green":
      return <Dot tone="green" />;
    case "preparing":
      return <LoaderCircleIcon aria-hidden className={cn(markIcon, "text-faint")} />;
    case "queued":
      return <CircleDashedIcon aria-hidden className={cn(markIcon, "text-faint")} />;
    case "review":
      return <GitPullRequestIcon aria-hidden className={cn(markIcon, "text-muted")} />;
    case "stopped":
      return <SquareIcon aria-hidden className={cn(markIcon, "text-faint")} />;
    case "merged":
      return <GitMergeIcon aria-hidden className={cn(markIcon, "text-faint")} />;
    case "done":
      return <CheckIcon aria-hidden className={cn(markIcon, "text-faint")} />;
    default:
      return mark satisfies never;
  }
};

const Doing = ({ segments }: { readonly segments: readonly Segment[] }) =>
  segments.map((segment, i) =>
    segment.style === "plain" ? (
      <Fragment key={i}>{segment.text}</Fragment>
    ) : (
      <span key={i} className={cn("text-text", segment.style === "code" && "font-mono text-ui")}>
        {segment.text}
      </span>
    ),
  );

const Row = ({ task, now }: { readonly task: TaskRow; readonly now: number }) => (
  <li data-task={task.id} data-state={task.state} className="border-b border-line">
    <Link
      href={`/tasks/${task.id}`}
      className={cn(rowGrid, "h-10 pl-[5px] pr-1.5 hover:bg-raise focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted")}
    >
      <span className="grid place-items-center">
        <Mark mark={taskMark(task.state)} />
        <span className="sr-only">{taskStateText(task.state)}</span>
      </span>
      <span className="truncate font-mono text-ui text-faint">{task.key}</span>
      <span className="truncate pr-4 text-text">{task.title}</span>
      <span className="hidden truncate pr-4 text-muted md:block">
        <Doing segments={doingNow(task)} />
      </span>
      <span className="hidden min-w-0 items-center gap-2 md:flex">
        {task.runner === null ? null : (
          <>
            {task.runner.kind === "personal" ? (
              <LaptopIcon aria-hidden className={cn(markIcon, "shrink-0 text-faint")} />
            ) : (
              <ServerIcon aria-hidden className={cn(markIcon, "shrink-0 text-faint")} />
            )}
            <span className="truncate font-mono text-ui text-muted">{task.runner.name}</span>
          </>
        )}
      </span>
      <span className="hidden md:block">{task.driver === null ? null : <Avatar name={task.driver.name} />}</span>
      <span className="text-right font-mono text-ui text-faint">{formatAge(task.createdAt, now)}</span>
    </Link>
  </li>
);

const BandIcon = ({ group, open }: { readonly group: TaskGroup; readonly open: boolean }) => {
  switch (group) {
    case "needs-you":
      return <Dot tone="amber" />;
    case "running":
      return <Dot tone="green" />;
    case "queued":
      return <CircleDashedIcon aria-hidden className={cn(bandIcon, "text-faint")} />;
    case "in-review":
      return <GitPullRequestIcon aria-hidden className={cn(bandIcon, "text-muted")} />;
    case "finished":
      return open ? <ChevronDownIcon aria-hidden className={cn(bandIcon, "text-muted")} /> : <ChevronRightIcon aria-hidden className={cn(bandIcon, "text-muted")} />;
    default:
      return group satisfies never;
  }
};

const bandClass = "flex h-[34px] w-full items-center gap-2 rounded-sm bg-surface px-3 text-left";

const BandLabel = ({ group, count, open }: { readonly group: TaskGroup; readonly count: number; readonly open: boolean }) => (
  <>
    <span className="grid w-[15px] place-items-center">
      <BandIcon group={group} open={open} />
    </span>
    <span className="font-semibold text-text">{groupText(group)}</span>
    <span className="font-mono text-[12.5px] font-normal text-faint">{count}</span>
  </>
);

/** A group: its band, then its rows. Only "Stopped and done" folds, and it starts folded. */
const GroupSection = ({ group, now }: { readonly group: Group; readonly now: number }) => {
  const [open, setOpen] = useState(false);
  const rows = (
    <ul aria-label={groupText(group.group)}>
      {group.tasks.map((task) => <Row key={task.id} task={task} now={now} />)}
    </ul>
  );
  if (group.group !== "finished") {
    return (
      <section data-group={group.group} className="mt-[18px] first:mt-0">
        <h2 className={cn(bandClass, "text-body")}>
          <BandLabel group={group.group} count={group.tasks.length} open />
        </h2>
        {rows}
      </section>
    );
  }
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} asChild>
      <section data-group={group.group} className="mt-[18px] first:mt-0">
        <h2 className="text-body">
          <Collapsible.Trigger className={cn(bandClass, "hover:bg-raise")}>
            <BandLabel group={group.group} count={group.tasks.length} open={open} />
          </Collapsible.Trigger>
        </h2>
        <Collapsible.Content>{rows}</Collapsible.Content>
      </section>
    </Collapsible.Root>
  );
};

const LoadingList = () => (
  <div aria-busy className="mt-[22px]">
    {[0, 1, 2].map((band) => (
      <div key={band} className="mt-[18px] first:mt-0">
        <Skeleton className="h-8" />
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex h-10 items-center gap-4 border-b border-line pl-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    ))}
  </div>
);

/**
 * A project's home (project.md, ticket 38): what its tasks are doing, grouped by state in the
 * domain model's order, and the composer that starts one from a prompt (F-097).
 */
export const ProjectView = ({ projectId }: { readonly projectId: ProjectId }) => {
  const trpc = useTRPC();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const boards = useQuery(trpc.boards.get.queryOptions({ projectId }));
  const groups = useQuery(trpc.tasks.list.queryOptions({ projectId }));
  const now = useNow(30_000);
  const shown = groups.data?.filter((group) => group.tasks.length > 0) ?? [];
  const counts = project.data === undefined ? [] : ledeCounts(project.data.needsYouCount, project.data.runningCount);

  return (
    <PageFrame
      crumbs={[{ label: project.data?.name ?? "" }, { label: t("shell.tasks") }]}
      properties={project.data === undefined ? undefined : <ProjectProperties project={project.data} boardKeys={boards.data?.boards.map((board) => board.key ?? board.name)} />}
    >
      {project.error === null ? null : <p role="alert" className="text-red">{errorText(project.error)}</p>}
      {project.data === undefined ? (
        project.error === null ? (
          <div className="mb-2">
            <Skeleton className="mt-1.5 h-[30px] w-48" />
            <Skeleton className="mt-2 h-4 w-80" />
          </div>
        ) : null
      ) : (
        <div className="mb-2">
          <h1 className="page-title my-1.5 break-words">{project.data.name}</h1>
          <p className="text-lede text-muted">
            {project.data.repos.map((repo, i) => (
              <Fragment key={repo.repoId}>
                {i > 0 ? ", " : null}
                <span className="font-mono text-body text-text">{repo.fullName}</span>
              </Fragment>
            ))}
            {counts.map((count) => <Fragment key={count}>{` · ${count}`}</Fragment>)}
          </p>
        </div>
      )}
      <div className="mt-[18px]">
        <ProjectComposer projectId={projectId} repos={project.data?.repos ?? []} />
      </div>
      {groups.error === null ? null : <p role="alert" className="mt-6 text-red">{errorText(groups.error)}</p>}
      {groups.isPending ? <LoadingList /> : null}
      {groups.data !== undefined && shown.length === 0 ? <p className="mt-6 text-muted">{t("tasks.none")}</p> : null}
      {shown.length === 0 ? null : (
        <div className="mt-[22px]" data-testid="task-groups">
          {shown.map((group) => <GroupSection key={group.group} group={group} now={now} />)}
        </div>
      )}
    </PageFrame>
  );
};
