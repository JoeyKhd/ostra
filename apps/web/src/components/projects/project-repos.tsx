"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranchIcon, GripVerticalIcon, InfoIcon, LockIcon, PlusIcon, RefreshCwIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";

import type { ProjectId, RepoId } from "@ostra/protocol";

import { PageFrame, PageHeading, PropRow } from "@/components/shell/page-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";

import { RepoCheckLine } from "./repo-check-line";
import { BlockedNotice, RepoBlocksLoading, RepoProperties, ReposLede } from "./repo-checks";
import { checkLines, repoVerdict } from "./repo-checks-words";
import type { RepoDetail } from "./repo-checks-words";
import { ProjectSettingsTabs } from "./settings-tabs";

// A project's repos (F-098; app-targets/m4/project-repos.md), under Settings: the repos in the order
// every session checks them out side by side, reordered by dragging a handle or with ↑ and ↓ on it,
// "Add repo" from the linked installations' repos, and a removal that's refused while unfinished
// tasks have a branch in the repo, naming them. Each repo's branch-rule checks are milestone 2's.

type RepoUse = RouterOutputs["projects"]["repos"][number];

/** Moves `id` one place up or down: the order the save sends. */
export const moveRepo = <T,>(order: readonly T[], id: T, step: -1 | 1): readonly T[] => {
  const at = order.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
};

/** Puts `id` where `target` is: a drop. */
export const dropRepo = <T,>(order: readonly T[], id: T, target: T): readonly T[] => {
  if (id === target) return order;
  const next = order.filter((one) => one !== id);
  next.splice(next.indexOf(target) + (order.indexOf(id) < order.indexOf(target) ? 1 : 0), 0, id);
  return next;
};

const AddRepo = ({ projectId, taken, full }: { readonly projectId: ProjectId; readonly taken: ReadonlySet<string>; readonly full: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useQuery({ ...trpc.github.reposByAccount.queryOptions(), enabled: open });
  const add = useMutation(
    trpc.projects.addRepo.mutationOptions({
      onSuccess: async () => {
        setOpen(false);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.projects.repos.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }),
        ]);
      },
    }),
  );
  const offered = (groups.data ?? []).flatMap((group) => group.repos.filter((repo) => !taken.has(repo.fullName.toLowerCase()) && repo.fullName.toLowerCase().includes(query.trim().toLowerCase())));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="primary" disabled={full} data-testid="add-repo">
          <PlusIcon aria-hidden />
          {t("projectRepos.add")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-2">
        <Input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder={t("projectRepos.addFilter")} aria-label={t("projectRepos.addFilter")} className="mb-2 h-8" />
        {groups.isPending ? (
          <Skeleton className="h-6 w-full" />
        ) : offered.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted">{t("projectRepos.addNone")}</p>
        ) : (
          <ul className="max-h-[280px] overflow-y-auto" role="listbox" aria-label={t("projectRepos.add")}>
            {offered.map((repo) => (
              <li key={repo.fullName}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={add.isPending}
                  onClick={() => { add.mutate({ projectId, fullName: repo.fullName }); }}
                  className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left hover:bg-hover"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-ui text-text">{repo.fullName}</span>
                  {repo.private ? <LockIcon aria-hidden className="size-3 text-faint" /> : null}
                  <span className="font-mono text-xs text-faint">{repo.defaultBranch}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {add.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(add.error)}</p>}
      </PopoverContent>
    </Popover>
  );
};

const RepoPanel = ({ projectId, repo, use, count, admin, now }: { readonly projectId: ProjectId; readonly repo: RepoDetail; readonly use: RepoUse | undefined; readonly count: number; readonly admin: boolean; readonly now: number }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const remove = useMutation(
    trpc.projects.removeRepo.mutationOptions({
      onSuccess: async (result) => {
        if (!result.removed) return;
        router.replace(pathname, { scroll: false });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.projects.repos.queryKey({ projectId }) }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }),
        ]);
      },
    }),
  );
  const refused = remove.data?.removed === false ? remove.data : null;
  const tasks = use?.tasks ?? [];
  return (
    <div data-testid="project-repo-panel">
      <RepoProperties repo={repo} now={now} />
      <div className="mt-3.5 border-t border-line pt-3.5">
        <PropRow label={t("projectRepos.position")} labelWidth={112}>
          <span className="font-mono">{t("projectRepos.positionOf", { n: (use?.position ?? 0) + 1, of: count })}</span>
        </PropRow>
        <PropRow label={t("projectRepos.folder")} labelWidth={112}>
          <span className="font-mono">{use === undefined ? "–" : `${use.checkoutDir}/`}</span>
        </PropRow>
      </div>
      <div className="mt-3.5 border-t border-line pt-3.5">
        <h3 className="mb-1.5 text-body font-semibold text-text">{tasks.length === 0 ? t("projectRepos.noOpenTasks") : plural(tasks.length, "projectRepos.inUse.one", "projectRepos.inUse.other")}</h3>
        <ul data-testid="repo-tasks">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex h-8 items-center gap-3 text-ui">
              <span className="w-[76px] shrink-0 font-mono text-sm text-muted">{task.ticketKey ?? task.taskId.slice(-7)}</span>
              <Link href={`/tasks/${task.taskId}`} className="min-w-0 truncate text-text hover:underline">{task.title}</Link>
            </li>
          ))}
        </ul>
        {tasks.length === 0 ? null : <p className="mt-1.5 text-sm text-muted">{t("projectRepos.cantRemove")}</p>}
        {admin ? (
          <Button
            variant="outline"
            className="mt-3 w-full"
            disabled={remove.isPending || count <= 1}
            data-testid="remove-repo"
            onClick={() => { remove.mutate({ projectId, repoId: repo.repoId }); }}
          >
            <Trash2Icon aria-hidden />
            {t("projectRepos.remove")}
          </Button>
        ) : null}
        {refused === null ? null : (
          <div role="alert" className="mt-2 text-sm text-red" data-testid="remove-refused">
            {t("projectRepos.removeRefused")}
            <ul className="mt-1 text-muted">
              {refused.tasks.map((task) => <li key={task.taskId}>{task.ticketKey === null ? task.title : `${task.ticketKey} · ${task.title}`}</li>)}
            </ul>
          </div>
        )}
        {remove.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(remove.error)}</p>}
      </div>
      <div className="mt-3.5 border-t border-line pt-3.5">
        <h3 className="mb-1 text-body font-semibold text-text">{t("projectRepos.orderTitle")}</h3>
        <p className="text-ui text-muted">{t("projectRepos.orderBody")}</p>
      </div>
    </div>
  );
};

/** Settings › Repos. */
export const ProjectReposView = ({ projectId, maxRepos }: { readonly projectId: ProjectId; readonly maxRepos: number }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const project = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const uses = useQuery(trpc.projects.repos.queryOptions({ projectId }));
  const [mounted] = useState(() => Date.now());
  const [dragging, setDragging] = useState<RepoId | null>(null);
  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.projects.repos.queryKey({ projectId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ projectId }) }),
    ]);
  };
  const reorder = useMutation(trpc.projects.reorderRepos.mutationOptions({ onSettled: refresh }));
  const check = useMutation(trpc.projects.checkRepos.mutationOptions({ onSuccess: refresh }));
  const [pending, setPending] = useState<readonly RepoId[] | null>(null);
  const details = project.data?.repos ?? [];
  const serverOrder = (uses.data ?? []).map((use) => use.repoId);
  const order = pending ?? serverOrder;
  const rows = order.flatMap((id) => {
    const repo = details.find((one) => one.repoId === id);
    return repo === undefined ? [] : [{ repo, use: uses.data?.find((one) => one.repoId === id) }];
  });
  const selectedId = params.get("repo");
  const selected = rows.find((row) => row.repo.repoId === selectedId) ?? rows[0];
  const admin = project.data?.role === "admin";
  const now = project.dataUpdatedAt === 0 ? mounted : project.dataUpdatedAt;
  const save = (next: readonly RepoId[]): void => {
    if (next.join() === order.join()) return;
    setPending(next);
    reorder.mutate({ projectId, repoIds: [...next] }, { onSettled: () => { setPending(null); } });
  };
  const onHandleKey = (event: KeyboardEvent, id: RepoId): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    save(moveRepo(order, id, event.key === "ArrowUp" ? -1 : 1));
  };
  const select = (id: RepoId): void => { router.replace(`${pathname}?repo=${id}`, { scroll: false }); };

  return (
    <PageFrame
      crumbs={[{ label: project.data?.name ?? "", href: `/projects/${projectId}` }, { label: t("projectSettings.title") }, { label: t("projectRepos.title") }]}
      actions={
        admin ? (
          <span className="flex items-center gap-2">
            <Button onClick={() => { check.mutate({ projectId }); }} disabled={check.isPending}>
              <RefreshCwIcon className={cn("stroke-[1.75]", check.isPending && "animate-spin motion-reduce:animate-none")} />
              {check.isPending ? t("repos.checking") : t("repos.checkAgain")}
            </Button>
            <AddRepo projectId={projectId} taken={new Set(details.map((repo) => repo.fullName.toLowerCase()))} full={details.length >= maxRepos} />
          </span>
        ) : undefined
      }
      properties={selected === undefined ? undefined : <RepoPanel projectId={projectId} repo={selected.repo} use={selected.use} count={rows.length} admin={admin} now={now} />}
    >
      <ProjectSettingsTabs projectId={projectId} admin={admin} />
      <PageHeading
        title={t("projectRepos.title")}
        lede={
          project.data === undefined ? (
            <Skeleton className="mt-1 w-[240px]" />
          ) : (
            <>
              <span className="block">{t("projectRepos.lede")}</span>
              <span className="font-mono text-ui text-muted"><ReposLede repos={details} now={now} /></span>
            </>
          )
        }
      />
      {project.isError ? (
        <p role="alert" className="mt-6 flex items-start gap-2 text-ui text-red">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-[14px] shrink-0 stroke-[1.75]" />
          {errorText(project.error)}
        </p>
      ) : project.data === undefined || uses.data === undefined ? (
        <RepoBlocksLoading />
      ) : (
        <div className="max-w-[760px]">
          <BlockedNotice repos={details} />
          {reorder.error === null ? null : <p role="alert" className="mt-3 text-ui text-red">{errorText(reorder.error)}</p>}
          <ol className="mt-[18px]" data-testid="project-repos">
            {rows.map(({ repo, use }, index) => {
              const verdict = repoVerdict(repo);
              const tasks = use?.tasks.length ?? 0;
              return (
                <li
                  key={repo.repoId}
                  data-repo={repo.fullName}
                  className={cn("border-b border-line first:border-t", dragging === repo.repoId && "opacity-60")}
                  onDragOver={(event: DragEvent) => { if (dragging !== null) event.preventDefault(); }}
                  onDrop={(event: DragEvent) => {
                    event.preventDefault();
                    if (dragging !== null) save(dropRepo(order, dragging, repo.repoId));
                    setDragging(null);
                  }}
                >
                  <div className={cn("my-1 flex items-start gap-2 rounded-md px-1.5 py-2 hover:bg-hover", selected?.repo.repoId === repo.repoId && "bg-sel hover:bg-sel")}>
                    {admin ? (
                      <button
                        type="button"
                        draggable
                        aria-label={t("projectRepos.move", { repo: repo.fullName })}
                        aria-describedby="repos-reorder-help"
                        data-testid="repo-handle"
                        onDragStart={() => { setDragging(repo.repoId); }}
                        onDragEnd={() => { setDragging(null); }}
                        onKeyDown={(event) => { onHandleKey(event, repo.repoId); }}
                        className="mt-1 cursor-grab rounded-sm p-0.5 text-faint hover:text-text focus-visible:outline-2 focus-visible:outline-muted"
                      >
                        <GripVerticalIcon aria-hidden className="size-[15px]" />
                      </button>
                    ) : null}
                    <span className="mt-1 w-5 shrink-0 font-mono text-ui text-muted" data-testid="repo-position">{index + 1}</span>
                    <button type="button" aria-pressed={selected?.repo.repoId === repo.repoId} onClick={() => { select(repo.repoId); }} className="min-w-0 flex-1 text-left" data-testid="repo-select">
                      <span className="flex min-h-7 items-center gap-3">
                        <GitBranchIcon aria-hidden className="size-[15px] shrink-0 stroke-[1.75] text-faint" />
                        <span className="min-w-0 truncate font-mono text-body text-text">{repo.fullName}</span>
                        {repo.private === true ? <LockIcon aria-label={t("repos.private")} className="size-[14px] shrink-0 stroke-[1.75] text-faint" /> : null}
                        <span className="hidden font-mono text-ui text-faint sm:inline">{repo.defaultBranch}</span>
                        <span className="ml-auto hidden shrink-0 text-ui text-muted md:inline" data-testid="repo-use">{tasks === 0 ? t("projectRepos.noOpenTasks") : plural(tasks, "projectRepos.inUse.one", "projectRepos.inUse.other")}</span>
                        <span className={cn("w-[88px] shrink-0 text-right text-ui", verdict === "ready" ? "text-muted" : verdict === "warning" ? "text-text" : "text-red")}>{t(`repos.verdict.${verdict}`)}</span>
                      </span>
                      <ul className="pl-[27px]">
                        {checkLines(repo).map((line) => <RepoCheckLine key={line.kind} line={line} />)}
                      </ul>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <p id="repos-reorder-help" className="mt-4 flex items-start gap-2 text-xs text-faint">
            <InfoIcon aria-hidden className="mt-0.5 size-[13px] shrink-0 stroke-[1.75]" />
            <span>{t("projectRepos.help", { max: maxRepos })}</span>
          </p>
          <RepoSkillsSetting projectId={projectId} on={project.data.repoSkills} admin={admin} />
        </div>
      )}
    </PageFrame>
  );
};

/**
 * Whether each repo's own skills reach the agent (F-021, ADR 0049 amended 2026-11-21): on by
 * default, a project admin's switch, saved on its own as the Review settings' switches are.
 */
const RepoSkillsSetting = ({ projectId, on, admin }: { readonly projectId: ProjectId; readonly on: boolean; readonly admin: boolean }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const key = trpc.projects.get.queryKey({ projectId });
  const set = useMutation(
    trpc.projects.setRepoSkills.mutationOptions({
      onMutate: async (input) => {
        await queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData(key, (old) => (old === undefined ? old : { ...old, repoSkills: input.on }));
      },
      onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    }),
  );
  return (
    <section className="mt-8 border-t border-line py-5" data-testid="repo-skills">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 id="repo-skills-title" className="text-[15px] font-semibold text-text">{t("projectRepos.skillsTitle")}</h2>
          <div className="mt-1 max-w-[600px] text-sm text-muted">
            <p>{on ? t("projectRepos.skillsOnBody") : t("projectRepos.skillsOffBody")}</p>
            <p className="mt-1 text-xs text-faint">{t("projectRepos.skillsNote")}</p>
            {set.error === null ? null : <p className="mt-1 text-xs text-red" role="alert">{errorText(set.error)}</p>}
          </div>
        </div>
        <Switch
          aria-labelledby="repo-skills-title"
          checked={on}
          disabled={!admin || set.isPending}
          onCheckedChange={(next) => { set.mutate({ projectId, on: next }); }}
          data-testid="repo-skills-switch"
        />
      </div>
    </section>
  );
};
