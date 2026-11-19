"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  InfoIcon,
  LaptopIcon,
  LoaderCircleIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SquareTerminalIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Popover, Tooltip } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode, SubmitEvent } from "react";

import { branchSlugFor, titleFromPrompt } from "@ostra/domain/branch-name";
import { runnerIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { runnerStateText } from "@/components/runners/runner-words";
import { PageFrame, PageHeading, PropGroup, PropRow, Section, SectionLink } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { doingText, taskStateText } from "./task-words";

type ProjectSummary = RouterOutputs["projects"]["list"][number];
type ProjectDetail = RouterOutputs["projects"]["get"];
type Runner = RouterOutputs["runners"]["mine"][number];
type TaskSummary = RouterOutputs["tasks"]["list"][number]["tasks"][number];

const POOLS = "pools";

// ---------- small parts ----------

/** The project's 8px square (`.pdot`): its colour, on this square only. */
const ProjectDot = ({ projectId }: { readonly projectId: string }) => (
  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(projectId) }} />
);

/** A ghost trigger in the composer's footer: 28px, no border, `--raise` on hover, a faint chevron. */
const Trigger = ({ className, children, chevron = true, ...props }: ComponentProps<"button"> & { readonly chevron?: boolean }) => (
  <button
    type="button"
    className={cn(
      "inline-flex h-7 min-w-0 items-center gap-[7px] rounded-md px-2 text-[12.5px] font-medium text-text enabled:hover:bg-raise disabled:cursor-default data-[state=open]:bg-raise [&_svg]:size-[15px] [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg]:text-muted",
      className,
    )}
    {...props}
  >
    {children}
    {chevron ? <ChevronDownIcon aria-hidden className="!size-3 !text-faint" /> : null}
  </button>
);

/** `⌘ ↵` on macOS and `Ctrl ↵` elsewhere; ⌘ until the browser says which (no hydration mismatch). */
const useSubmitHint = (): string => {
  const [mac, setMac] = useState(true);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.userAgent));
  }, []);
  return mac ? "⌘ ↵" : "Ctrl ↵";
};

/** A refusal's "… under Models" ends in a teal link to Models (task-new.md, "Refused / error"). Never amber. */
const ErrorLine = ({ text }: { readonly text: string }) => {
  const word = "Models";
  const linked = text.endsWith(` ${word}`);
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-[12.5px] text-red" data-testid="new-task-error">
      <CircleAlertIcon aria-hidden className="mt-[3px] size-[13px] shrink-0 stroke-[1.75]" />
      <span>
        {linked ? text.slice(0, -word.length) : text}
        {linked ? <Link href="/organization/models" className="text-teal hover:underline">{word}</Link> : null}
      </span>
    </p>
  );
};

// ---------- the pickers ----------

const ProjectPicker = ({ projects, project, onPick, disabled }: {
  readonly projects: readonly ProjectSummary[];
  readonly project: ProjectSummary;
  readonly onPick: (projectId: ProjectId) => void;
  readonly disabled: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = projects.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const pick = (projectId: ProjectId) => {
    onPick(projectId);
    setOpen(false);
    setFilter("");
  };
  return (
    <Popover.Root open={open} onOpenChange={(next) => { setOpen(next); if (!next) setFilter(""); }}>
      <Popover.Trigger asChild>
        <Trigger aria-label={t("newTask.pickProject")} disabled={disabled} data-testid="pick-project">
          <ProjectDot projectId={project.id} />
          <span className="truncate">{project.name}</span>
        </Trigger>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[240px] rounded-md border border-line-2 bg-raise p-1 text-body text-text shadow-[0_8px_24px_rgba(0,0,0,0.45)] focus:outline-none"
        >
          <input
            autoFocus
            aria-label={t("newTask.filterProjects")}
            placeholder={t("newTask.filterProjects")}
            value={filter}
            onChange={(event) => { setFilter(event.target.value); }}
            onKeyDown={(event) => {
              const first = shown[0];
              if (event.key === "Enter" && first !== undefined) {
                event.preventDefault();
                pick(first.id);
              }
            }}
            className="mb-1 h-7 w-full border-b border-line bg-transparent px-2 text-body text-text outline-none placeholder:text-faint focus-visible:outline-none"
          />
          <ul role="listbox" aria-label={t("newTask.pickProject")}>
            {shown.map((item) => (
              <li key={item.id} role="option" aria-selected={item.id === project.id}>
                <button
                  type="button"
                  onClick={() => { pick(item.id); }}
                  className={cn("flex h-7 w-full items-center gap-[9px] rounded-sm px-2 text-left hover:bg-sel", item.id === project.id && "bg-sel")}
                >
                  <ProjectDot projectId={item.id} />
                  <span className="truncate">{item.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};

/** Read-only in milestone 1: the project's default code profile always applies (F-021 makes it a picker). */
const ProfileTrigger = ({ profile }: { readonly profile: ProjectDetail["defaultCodeProfile"] | undefined }) => (
  <Tooltip.Provider delayDuration={300}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Trigger chevron={false} className="cursor-default enabled:hover:bg-transparent" data-testid="agent-profile">
          <SlidersHorizontalIcon aria-hidden />
          {profile === undefined ? <Skeleton className="w-[150px]" /> : (
            <span className="truncate">
              {profile === null ? t("newTask.noModel") : `${profile.agentName} · ${profile.model?.name ?? t("newTask.noModel")}`}
            </span>
          )}
        </Trigger>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="bottom" sideOffset={6} className="z-50 max-w-[260px] rounded-md border border-line-2 bg-surface px-2 py-1 text-[12px] text-text shadow-lg">
          {t("newTask.profileReadOnly")}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
);

const RunOnPicker = ({ runners, runner, onPick, disabled }: {
  readonly runners: readonly Runner[] | undefined;
  readonly runner: Runner | null;
  readonly onPick: (value: string) => void;
  readonly disabled: boolean;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Trigger aria-label={t("newTask.runOnPick")} disabled={disabled || runners === undefined} data-testid="run-on">
        {runners === undefined ? <Skeleton className="w-[110px]" /> : runner === null ? (
          <>
            <ServerIcon aria-hidden />
            <span className="truncate">{t("newTask.pools")}</span>
          </>
        ) : (
          <>
            <LaptopIcon aria-hidden />
            <span className="truncate">{runner.name}</span>
            <span className="font-normal text-muted">· {t("newTask.yoursShort")}</span>
          </>
        )}
      </Trigger>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-[260px]">
      {(runners ?? []).map((item) => (
        <DropdownMenuItem key={item.id} onSelect={() => { onPick(item.id); }} data-runner={item.name}>
          <LaptopIcon aria-hidden />
          <span className="font-mono text-[12.5px]">{item.name}</span>
          <span className="text-muted">· {t("newTask.yoursShort")}</span>
          <span className="ml-auto pl-3 text-sm">
            {item.state === "online" ? <Status tone="green" className="text-muted">{t("newTask.online")}</Status> : <span className="text-faint">{runnerStateText(item.state)}</span>}
          </span>
        </DropdownMenuItem>
      ))}
      {(runners ?? []).length === 0 ? null : <DropdownMenuSeparator />}
      <DropdownMenuItem onSelect={() => { onPick(POOLS); }} data-runner={POOLS}>
        <ServerIcon aria-hidden />
        {t("newTask.pools")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

// ---------- below the composer ----------

const Code = ({ children }: { readonly children: ReactNode }) => <span className="font-mono text-[12.5px] text-text">{children}</span>;

/** A message with nodes in its `{name}` placeholders (repo names and branches in mono). */
const fill = (template: string, parts: Readonly<Record<string, ReactNode>>): ReactNode[] =>
  template.split(/(\{\w+\})/g).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <span key={i}>{name === undefined ? piece : (parts[name] ?? piece)}</span>;
  });

const NextRow = ({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) => (
  <li className="flex min-h-[38px] items-center gap-3 py-1.5 text-body">
    <span className="flex w-[15px] shrink-0 text-muted [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">{icon}</span>
    <span className="min-w-0 break-words">{children}</span>
  </li>
);

const WhatHappensNext = ({ project, agentName, runner, slug }: {
  readonly project: ProjectSummary;
  readonly agentName: string;
  readonly runner: Runner | null;
  readonly slug: string | null;
}) => {
  const repo = project.repos[0];
  return (
    <Section title={t("newTask.nextTitle")} className="mt-8">
      <ul className="rows" data-testid="what-happens-next">
        {repo === undefined ? null : (
          <NextRow icon={<FolderGit2Icon aria-hidden />}>
            {runner === null
              ? fill(t("newTask.nextBox"), { repo: <Code>{repo.fullName}</Code>, base: <Code>{repo.defaultBranch}</Code> })
              : fill(t("newTask.nextWorktree"), { repo: <Code>{repo.fullName}</Code>, base: <Code>{repo.defaultBranch}</Code>, runner: <Code>{runner.name}</Code> })}
          </NextRow>
        )}
        <NextRow icon={<GitBranchIcon aria-hidden />}>
          {slug === null ? t("newTask.nextBranchEmpty", { agent: agentName }) : (
            <>
              {t("newTask.nextBranch", { agent: agentName })}{" "}
              <span className="font-mono text-[12.5px] text-text" data-testid="branch-preview">ostra/<span className="text-faint">…</span>-{slug}</span>
            </>
          )}
        </NextRow>
        <NextRow icon={<GitPullRequestIcon aria-hidden />}>{t("newTask.nextPr")}</NextRow>
      </ul>
    </Section>
  );
};

/** The state column of a recent task: a dot and its word; merged gets the git-merge mark. */
const RecentState = ({ task }: { readonly task: TaskSummary }) => {
  switch (task.state) {
    case "merged":
    case "done":
      return (
        <span className="inline-flex items-center gap-[7px]">
          <GitMergeIcon aria-hidden className="size-[13px] stroke-[1.75] text-faint" />
          {taskStateText(task.state)}
        </span>
      );
    case "running":
    case "preparing":
      return <Status tone="green">{taskStateText(task.state)}</Status>;
    case "needs_you":
    case "awaiting_approval":
      return <Status tone="amber">{taskStateText(task.state)}</Status>;
    case "queued":
    case "in_review":
    case "stopped":
      return <Status tone="grey">{taskStateText(task.state)}</Status>;
    default:
      return task.state satisfies never;
  }
};

/** What happened, in a few words: its PR, or what the agent is doing now. */
const RecentWhat = ({ task, agentName }: { readonly task: TaskSummary; readonly agentName: string }) => {
  const pr = task.prs[0];
  if (pr !== undefined) return <>PR <span className="font-mono">#{pr.number}</span></>;
  const doing = doingText(task.doing);
  return doing === "" ? null : <>{agentName} · {doing}</>;
};

const Recent = ({ project, tasks, agentName, now }: {
  readonly project: ProjectSummary;
  readonly tasks: readonly TaskSummary[];
  readonly agentName: string;
  readonly now: number;
}) => {
  if (tasks.length === 0) return null;
  const latest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  return (
    <Section
      title={t("newTask.recent", { project: project.name })}
      count={tasks.length}
      className="mt-8"
      end={<SectionLink href={`/projects/${project.id}`}>{t("newTask.allTasks")}</SectionLink>}
    >
      <ul className="rows" data-testid="recent-tasks">
        {latest.map((task) => (
          <li key={task.id}>
            <Link href={`/tasks/${task.id}`} className="flex h-[38px] items-center gap-3 text-body">
              <span className="w-[110px] shrink-0"><RecentState task={task} /></span>
              <span className="min-w-0 flex-1 truncate text-text">{task.title}</span>
              <span className="hidden min-w-0 max-w-[40%] truncate text-[12.5px] text-muted sm:block"><RecentWhat task={task} agentName={agentName} /></span>
              <span className="w-8 shrink-0 text-right font-mono text-sm text-faint">{formatAge(task.updatedAt, now)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
};

// ---------- the properties panel ----------

const PanelSkeleton = () => (
  <div aria-busy>
    {[t("newTask.thisTask"), t("newTask.agentProfile"), t("newTask.runsOn")].map((title) => (
      <PropGroup key={title} title={title}>
        {[0, 1, 2].map((row) => (
          <div key={row} className="grid h-[30px] grid-cols-[96px_minmax(0,1fr)] items-center gap-2">
            <Skeleton className="w-[56px]" />
            <Skeleton className="w-[120px]" />
          </div>
        ))}
      </PropGroup>
    ))}
  </div>
);

const Properties = ({ project, detail, runner }: {
  readonly project: ProjectSummary;
  readonly detail: ProjectDetail | undefined;
  readonly runner: Runner | null;
}) => {
  const repo = project.repos[0];
  const profile = detail?.defaultCodeProfile;
  return (
    <div data-testid="new-task-properties">
      <PropGroup title={t("newTask.thisTask")}>
        <PropRow label={t("newTask.keyProject")}><ProjectDot projectId={project.id} /><span className="truncate">{project.name}</span></PropRow>
        {repo === undefined ? null : (
          <>
            <PropRow label={t("newTask.keyRepo")}><span className="truncate font-mono text-[12.5px]">{repo.fullName}</span></PropRow>
            <PropRow label={t("newTask.keyBase")}><span className="truncate font-mono text-[12.5px]">{repo.defaultBranch}</span></PropRow>
          </>
        )}
        <PropRow label={t("newTask.keyBranch")}><span className="text-muted">{t("newTask.branchLater")}</span></PropRow>
      </PropGroup>
      <PropGroup title={t("newTask.agentProfile")}>
        {detail === undefined ? (
          <div className="flex h-[30px] items-center"><Skeleton className="w-[160px]" /></div>
        ) : (
          <>
            <PropRow label={t("newTask.keyProfile")}><span className="truncate">{profile?.name ?? "–"}</span></PropRow>
            {profile === null || profile === undefined ? null : (
              <PropRow label={t("newTask.keyAgent")}><SquareTerminalIcon aria-hidden /><span className="truncate">{profile.agentName}</span></PropRow>
            )}
            <PropRow label={t("newTask.keyModel")}>
              {profile?.model === null || profile?.model === undefined ? <span className="text-red" data-testid="no-model">{t("newTask.noModel")}</span> : (
                <><SparklesIcon aria-hidden /><span className="truncate">{profile.model.name}</span></>
              )}
            </PropRow>
          </>
        )}
      </PropGroup>
      <PropGroup title={t("newTask.runsOn")}>
        {runner === null ? (
          <>
            <PropRow label={t("newTask.keyRunner")}><ServerIcon aria-hidden /><span className="truncate">{t("newTask.pools")}</span></PropRow>
            <PropRow label={t("newTask.keyState")}><span className="text-muted">{t("newTask.stateLater")}</span></PropRow>
          </>
        ) : (
          <>
            <PropRow label={t("newTask.keyRunner")}>
              <LaptopIcon aria-hidden />
              <span className="truncate font-mono text-[12.5px]">{runner.name}</span>
              <span className="shrink-0 text-muted">· {t("newTask.yoursShort")}</span>
            </PropRow>
            <PropRow label={t("newTask.keyState")}>
              <Status tone={runner.state === "online" ? "green" : "grey"}>{runner.state === "online" ? t("newTask.online") : runnerStateText(runner.state)}</Status>
            </PropRow>
            <PropRow label={t("newTask.keyExecutor")}>
              <span className="text-muted">{runner.executor}{runner.isolated ? "" : ` · ${t("newTask.notIsolated")}`}</span>
            </PropRow>
          </>
        )}
      </PropGroup>
    </div>
  );
};

// ---------- the page ----------

/**
 * New task (task-new.md, F-097): one big composer whose footer picks the project, shows the agent
 * profile (read-only until F-021) and picks where it runs; around it, quietly, what will happen.
 * Starting lands on the task page.
 */
export const NewTaskView = () => {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery(trpc.me.get.queryOptions());
  const projects = useQuery(trpc.projects.list.queryOptions());
  const runners = useQuery(trpc.runners.mine.queryOptions());
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [runOn, setRunOn] = useState<string | null>(null);
  const hint = useSubmitHint();
  const [now] = useState(() => Date.now());
  const textarea = useRef<HTMLTextAreaElement>(null);

  const project = projects.data?.find((item) => item.id === picked) ?? projects.data?.[0];
  const projectId = project?.id;
  const detail = useQuery(trpc.projects.get.queryOptions(projectId === undefined ? skipToken : { projectId }));
  const tasks = useQuery(trpc.tasks.list.queryOptions(projectId === undefined ? skipToken : { projectId }));
  const recent = useMemo(() => (tasks.data ?? []).flatMap((group) => group.tasks), [tasks.data]);

  // Default: the first online personal runner, else the project's pools.
  const firstOnline = runners.data?.find((runner) => runner.state === "online")?.id;
  const chosen = runOn ?? firstOnline ?? POOLS;
  const runner = chosen === POOLS ? null : (runners.data?.find((item) => item.id === chosen) ?? null);
  const agentName = detail.data?.defaultCodeProfile?.agentName ?? t("task.agent");
  const slug = prompt.trim() === "" ? null : branchSlugFor(titleFromPrompt(prompt.trim()));

  const create = useMutation(
    trpc.tasks.create.mutationOptions({
      onSuccess: async ({ taskId }) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.tasks.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.pathKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.setup.status.queryKey() }),
        ]);
        router.push(`/tasks/${taskId}`);
      },
    }),
  );
  const starting = create.isPending || create.isSuccess;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (projectId === undefined || prompt.trim() === "" || starting) return;
    create.mutate({ projectId, prompt: prompt.trim(), ...(chosen === POOLS ? {} : { runnerId: runnerIdSchema.parse(chosen) }) });
  };

  const crumbs = [{ label: me.data?.organization?.name ?? "" }, { label: t("newTask.title") }];

  if (projects.data?.length === 0) {
    return (
      <PageFrame crumbs={crumbs}>
        <PageHeading title={t("newTask.title")} lede={t("newTask.lede")} />
        <p className="mt-4 text-body text-muted">{t("newTask.noProject")}</p>
        <Link href="/projects/new" className={cn(buttonVariants({ variant: "primary" }), "mt-3")}>{t("checklist.project.action")}</Link>
      </PageFrame>
    );
  }

  const loading = project === undefined;
  return (
    <PageFrame
      crumbs={crumbs}
      wideProperties
      properties={project === undefined ? <PanelSkeleton /> : <Properties project={project} detail={detail.data} runner={runner} />}
    >
      <div className="max-w-[760px]">
        <PageHeading
          {...(project === undefined ? {} : { eyebrow: t("newTask.eyebrow", { project: project.slug }) })}
          title={t("newTask.title")}
          lede={t("newTask.lede")}
        />
        <form
          onSubmit={submit}
          noValidate
          aria-label={t("newTask.title")}
          data-testid="new-task"
          className="mt-6 flex min-h-[250px] cursor-text flex-col rounded-[10px] border border-line-2 bg-surface px-4 pb-2.5 pt-3.5 focus-within:border-[#34363a]"
          onClick={(event) => { if (event.target === event.currentTarget) textarea.current?.focus(); }}
        >
          <label htmlFor="new-task-prompt" className="sr-only">{t("newTask.prompt")}</label>
          <textarea
            ref={textarea}
            id="new-task-prompt"
            autoFocus
            readOnly={starting}
            disabled={loading}
            className="block max-h-[50vh] min-h-[150px] w-full flex-1 resize-none bg-transparent text-[14px] leading-[1.6] text-text outline-none [field-sizing:content] placeholder:text-faint focus-visible:outline-none"
            placeholder={t("newTask.placeholder")}
            value={prompt}
            onChange={(event) => { setPrompt(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="mt-2.5 flex cursor-default flex-wrap items-center gap-1">
            {project === undefined || projects.data === undefined ? (
              <>
                <Trigger disabled><Skeleton className="w-[90px]" /></Trigger>
                <Trigger disabled chevron={false}><Skeleton className="w-[150px]" /></Trigger>
                <Trigger disabled><Skeleton className="w-[110px]" /></Trigger>
              </>
            ) : (
              <>
                <ProjectPicker projects={projects.data} project={project} onPick={setPicked} disabled={starting} />
                <ProfileTrigger profile={detail.data?.defaultCodeProfile} />
                <RunOnPicker runners={runners.data} runner={runner} onPick={setRunOn} disabled={starting} />
              </>
            )}
            <span className="ml-auto flex items-center gap-3">
              <Kbd aria-hidden>{hint}</Kbd>
              <Button type="submit" variant="primary" disabled={loading || starting || prompt.trim() === ""} data-action="start-task">
                {starting ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <ArrowUpIcon aria-hidden />}
                {starting ? t("newTask.starting") : t("newTask.startTask")}
              </Button>
            </span>
          </div>
        </form>
        {create.error === null ? (
          runner !== null && !runner.isolated ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-faint" data-testid="host-help">
              <InfoIcon aria-hidden className="size-[13px] shrink-0 stroke-[1.75]" />
              {t("newTask.hostHelp", { runner: runner.name })}
            </p>
          ) : null
        ) : (
          <ErrorLine text={errorText(create.error) ?? t("errors.unknown")} />
        )}
        {project === undefined ? null : (
          <>
            <WhatHappensNext project={project} agentName={agentName} runner={runner} slug={slug} />
            <Recent project={project} tasks={recent} agentName={agentName} now={now} />
          </>
        )}
      </div>
    </PageFrame>
  );
};
