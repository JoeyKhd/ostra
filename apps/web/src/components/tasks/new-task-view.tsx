"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpIcon,
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
import { Popover } from "radix-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SubmitEvent } from "react";

import { branchSlugFor, titleFromPrompt } from "@ostra/domain/branch-name";
import { runnerIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";

import { ProfilePicker, useStartProfile } from "@/components/agent-profiles/profile-picker";
import type { StartProfile } from "@/components/agent-profiles/profile-picker";
import { runnerStateText } from "@/components/runners/runner-words";
import { PageFrame, PageHeading, PropGroup, PropRow, Section, SectionLink } from "@/components/shell/page-frame";
import { projectColour } from "@/components/shell/project-colour";
import { ComposerRepoNotes, repoBlockId } from "@/components/projects/repo-check-line";
import { unsupportedRepos } from "@/components/projects/repo-checks-words";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatAge } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { BudgetReason } from "./budget-reason";
import type { BudgetWait } from "./budget-reason";
import { KeyRow, NoKeyNext, NoKeyReason, ProjectKeys } from "./no-key";
import type { NoKey } from "./no-key";
import { POOLS, RunOnPicker, Trigger, useRunOn } from "./run-on";
import { boxSizeText } from "./task-waiting-words";
import { doingText, taskStateText } from "./task-words";

type ProjectSummary = RouterOutputs["projects"]["list"][number];
type Runner = RouterOutputs["runners"]["mine"][number];

const NO_KEY_ID = "new-task-no-key";
const BUDGET_WAIT_ID = "new-task-budget-wait";
type TaskSummary = RouterOutputs["tasks"]["list"][number]["tasks"][number];


// ---------- small parts ----------

/** The project's 8px square (`.pdot`): its colour, on this square only. */
const ProjectDot = ({ projectId }: { readonly projectId: string }) => (
  <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColour(projectId) }} />
);

/** A ghost trigger in the composer's footer: 28px, no border, `--raise` on hover, a faint chevron. */

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
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-ui text-red" data-testid="new-task-error">
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
          className="z-50 w-[240px] rounded-md border border-line-2 bg-raise p-1 text-body text-text shadow-(--shadow-pop) focus:outline-none"
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
            className="mb-1 h-[30px] w-full border-b border-line bg-transparent px-2 text-body text-text outline-none placeholder:text-faint focus-visible:outline-none"
          />
          <ul role="listbox" aria-label={t("newTask.pickProject")}>
            {shown.map((item) => (
              <li key={item.id} role="option" aria-selected={item.id === project.id}>
                <button
                  type="button"
                  onClick={() => { pick(item.id); }}
                  className={cn("flex h-[30px] w-full items-center gap-[9px] rounded-sm px-2 text-left hover:bg-sel", item.id === project.id && "bg-sel")}
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

// ---------- below the composer ----------

const Code = ({ children }: { readonly children: ReactNode }) => <span className="font-mono text-ui text-text">{children}</span>;

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
              <span className="font-mono text-ui text-text" data-testid="branch-preview">ostra/<span className="text-faint">…</span>-{slug}</span>
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
  if (pr !== undefined) return <>{t("newTask.recentPr")} <span className="font-mono">#{pr.number}</span></>;
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
              <span className="hidden min-w-0 max-w-[40%] truncate text-ui text-muted sm:block"><RecentWhat task={task} agentName={agentName} /></span>
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
          <div key={row} className="grid h-8 grid-cols-[92px_minmax(0,1fr)] items-center gap-2">
            <Skeleton className="w-[56px]" />
            <Skeleton className="w-[120px]" />
          </div>
        ))}
      </PropGroup>
    ))}
  </div>
);

const Properties = ({ project, profile, runner, boxSize, noKey, servingKey }: {
  readonly project: ProjectSummary;
  /** F-095: the project's default box size, which a task on a pool gets; `null` for none. */
  readonly boxSize: { readonly name: string; readonly cpuMillis: number; readonly memoryMiB: number } | null;
  /** F-135: the key that serves the profile's model in the project, from the New task check. */
  readonly servingKey: string | null;
  /** F-135: no key on the project's list serves the profile's model. */
  readonly noKey: NoKey | null;
  /** The chosen profile; `undefined` while the options load, `null` when none is offered. */
  readonly profile: StartProfile | null | undefined;
  readonly runner: Runner | null;
}) => {
  const repo = project.repos[0];
  return (
    <div data-testid="new-task-properties">
      <PropGroup title={t("newTask.thisTask")}>
        <PropRow label={t("newTask.keyProject")}><ProjectDot projectId={project.id} /><span className="truncate">{project.name}</span></PropRow>
        {repo === undefined ? null : (
          <>
            <PropRow label={t("newTask.keyRepo")}><span className="truncate font-mono text-ui">{repo.fullName}</span></PropRow>
            <PropRow label={t("newTask.keyBase")}><span className="truncate font-mono text-ui">{repo.defaultBranch}</span></PropRow>
          </>
        )}
        <PropRow label={t("newTask.keyBranch")}><span className="text-muted">{t("newTask.branchLater")}</span></PropRow>
      </PropGroup>
      <PropGroup title={t("newTask.agentProfile")}>
        {profile === undefined ? (
          <div className="flex h-[30px] items-center"><Skeleton className="w-[160px]" /></div>
        ) : (
          <>
            <PropRow label={t("newTask.keyProfile")}><SlidersHorizontalIcon aria-hidden /><span className="truncate" data-testid="chosen-profile">{profile?.name ?? "–"}</span></PropRow>
            {profile === null ? null : (
              <PropRow label={t("newTask.keyAgent")}><SquareTerminalIcon aria-hidden /><span className="truncate">{profile.agentName}</span></PropRow>
            )}
            <PropRow label={t("newTask.keyModel")}>
              {profile?.modelName === null || profile?.modelName === undefined ? <span className="text-red" data-testid="no-model">{t("newTask.noModel")}</span> : (
                <><SparklesIcon aria-hidden /><span className="truncate">{profile.modelName}</span></>
              )}
            </PropRow>
            {noKey !== null ? <KeyRow providerName={null} projectName={project.name} /> : servingKey === null ? null : <KeyRow providerName={servingKey} projectName={project.name} />}
          </>
        )}
      </PropGroup>
      {noKey === null ? null : <ProjectKeys projectId={project.id} noKey={noKey} />}
      <PropGroup title={t("newTask.runsOn")}>
        {runner === null ? (
          <>
            <PropRow label={t("newTask.keyRunner")}><ServerIcon aria-hidden /><span className="truncate">{t("runPicker.aPool")}</span></PropRow>
            <PropRow label={t("newTask.keyState")}><span className="text-muted">{t("newTask.stateLater")}</span></PropRow>
            <PropRow label={t("runPicker.boxSize")}>
              <span className="truncate font-mono text-ui" data-testid="new-task-box-size">
                {boxSize === null ? t("runPicker.boxSizeNone") : boxSizeText(boxSize)}
              </span>
            </PropRow>
          </>
        ) : (
          <>
            <PropRow label={t("newTask.keyRunner")}>
              <LaptopIcon aria-hidden />
              <span className="truncate font-mono text-ui">{runner.name}</span>
              <span className="shrink-0 text-muted">· {t("newTask.yoursShort")}</span>
            </PropRow>
            <PropRow label={t("newTask.keyState")}>
              <Status tone={runner.state === "online" ? "green" : "grey"}>{runner.state === "online" ? t("newTask.online") : runnerStateText(runner.state)}</Status>
            </PropRow>
            <PropRow label={t("newTask.keyExecutor")}>
              <span className="text-muted">{runner.executor}{runner.isolated ? "" : ` · ${t("newTask.notIsolated")}`}</span>
            </PropRow>
            <PropRow label={t("runPicker.boxSize")}><span className="truncate text-muted">{t("runPicker.personalNoSize")}</span></PropRow>
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
  const hint = useSubmitHint();
  const [now] = useState(() => Date.now());
  const textarea = useRef<HTMLTextAreaElement>(null);

  const project = projects.data?.find((item) => item.id === picked) ?? projects.data?.[0];
  const projectId = project?.id;
  const detail = useQuery(trpc.projects.get.queryOptions(projectId === undefined ? skipToken : { projectId }));
  const tasks = useQuery(trpc.tasks.list.queryOptions(projectId === undefined ? skipToken : { projectId }));
  const recent = useMemo(() => (tasks.data ?? []).flatMap((group) => group.tasks), [tasks.data]);

  // The member's profiles for this project, its default first (F-021).
  const profiles = useStartProfile(projectId);
  const profile = profiles.options === undefined ? undefined : profiles.chosen;
  // Milestone 5 (F-069, F-014): whether "A pool" and each "Your machine" can take it now, and why not.
  const choices = useQuery(
    trpc.tasks.runnerChoices.queryOptions(projectId === undefined || profile === undefined ? skipToken : { projectId, ...(profile === null ? {} : { profileId: profile.profileId }) }),
  );
  const { chosen, runner, setRunOn } = useRunOn(runners.data, choices.data);
  // F-095: the size its box gets on a pool: the project's default.
  const projectRunners = useQuery(trpc.projects.runners.queryOptions(projectId === undefined ? skipToken : { projectId }));
  const sizes = useQuery(trpc.boxSizes.list.queryOptions());
  const defaultSize = sizes.data?.find((size) => size.name === projectRunners.data?.defaultBoxSize) ?? null;
  const agentName = profile?.agentName ?? t("task.agent");
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
  // F-135: the project's keys and whether one serves the profile's model, re-run on every pick.
  const check = useQuery(
    trpc.tasks.startCheck.queryOptions(
      projectId === undefined || profile === undefined ? skipToken : { projectId, ...(profile === null ? {} : { profileId: profile.profileId }) },
    ),
  );
  const noKey: NoKey | null =
    check.data?.kind === "wait" && check.data.reason === "no-provider" && project !== undefined
      ? { model: profile?.modelName ?? check.data.modelName, mono: profile?.modelName === null || profile?.modelName === undefined, projectName: project.name, provider: check.data.provider }
      : null;
  const checking = check.isFetching;
  // F-037: the budget gate's reason; the task still starts, queued (ADR 0055).
  const budgetWait: BudgetWait | null =
    check.data?.kind !== "wait" ? null : check.data.reason === "budget-reached" ? { reason: "budget-reached", scope: check.data.scope, month: check.data.month } : check.data.reason === "unpriced" ? { reason: "unpriced" } : null;
  const organizationAdmin = me.data?.organization?.role === "admin";
  // Who can fix a missing key, by name and role only (no-key-for-model.md, open point 3).
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { enabled: noKey !== null && !organizationAdmin }));
  const admins = (members.data ?? []).filter((member) => member.role === "admin").map((member) => member.name);
  // A repo that requires signed commits stops every task in the project (F-055).
  const repos = detail.data?.repos ?? [];
  const blocked = unsupportedRepos(repos).length > 0;

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (projectId === undefined || prompt.trim() === "" || starting || blocked || noKey !== null || checking) return;
    create.mutate({
      projectId,
      prompt: prompt.trim(),
      ...(profile === undefined || profile === null ? {} : { agentProfileId: profile.profileId }),
      ...(chosen === POOLS ? {} : { runnerId: runnerIdSchema.parse(chosen) }),
    });
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
      properties={project === undefined ? <PanelSkeleton /> : <Properties project={project} profile={profile} runner={runner} boxSize={defaultSize} noKey={noKey} servingKey={check.data?.kind === "open" && check.data.providerName !== "" ? check.data.providerName : null} />}
    >
      <div>
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
          className="mt-6 flex min-h-[250px] cursor-text flex-col rounded-[10px] border border-line-2 bg-surface px-4 pb-2.5 pt-3.5 focus-within:border-line-3"
          onClick={(event) => { if (event.target === event.currentTarget) textarea.current?.focus(); }}
        >
          <label htmlFor="new-task-prompt" className="sr-only">{t("newTask.prompt")}</label>
          <textarea
            ref={textarea}
            id="new-task-prompt"
            autoFocus
            readOnly={starting}
            disabled={loading}
            className="block max-h-[50vh] min-h-[150px] w-full flex-1 resize-none bg-transparent text-[15.5px] leading-[1.6] text-text outline-none [field-sizing:content] placeholder:text-faint focus-visible:outline-none"
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
                <ProfilePicker options={profiles.options} chosen={profiles.chosen} onPick={profiles.pick} disabled={starting} />
                <RunOnPicker runners={runners.data} runner={runner} onPick={setRunOn} disabled={starting} choices={choices.data} project={project.name} />
              </>
            )}
            <span className="ml-auto flex items-center gap-3">
              <Kbd aria-hidden>{hint}</Kbd>
              <Button
                type="submit"
                // No key: the outline button dimmed, not the primary fill (no-key-for-model.md, section 1).
                variant={noKey === null ? "primary" : "outline"}
                disabled={loading || starting || prompt.trim() === "" || blocked || noKey !== null || checking}
                data-action="start-task"
                {...(blocked && projectId !== undefined ? { "aria-describedby": repoBlockId(projectId) } : noKey !== null ? { "aria-describedby": NO_KEY_ID } : budgetWait === null ? {} : { "aria-describedby": BUDGET_WAIT_ID })}
              >
                {starting || checking ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : <ArrowUpIcon aria-hidden />}
                {starting ? t("newTask.starting") : t("newTask.startTask")}
              </Button>
            </span>
          </div>
          {projectId === undefined ? null : <ComposerRepoNotes projectId={projectId} repos={repos} />}
        </form>
        {noKey === null || projectId === undefined ? null : (
          <NoKeyReason id={NO_KEY_ID} noKey={noKey} projectId={projectId} organizationAdmin={organizationAdmin} admins={admins} />
        )}
        {budgetWait === null || project === undefined ? null : (
          <BudgetReason id={BUDGET_WAIT_ID} wait={budgetWait} projectName={project.name} organizationAdmin={organizationAdmin} />
        )}
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
            {noKey === null ? (
              <WhatHappensNext project={project} agentName={agentName} runner={runner} slug={slug} />
            ) : (
              <Section title={t("newTask.nextTitle")} className="mt-8"><NoKeyNext noKey={noKey} /></Section>
            )}
            <Recent project={project} tasks={recent} agentName={agentName} now={now} />
          </>
        )}
      </div>
    </PageFrame>
  );
};
