"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranchIcon, GitPullRequestIcon, HandIcon, LaptopIcon, ServerIcon, SquareIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { taskIdSchema } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";

import { RunnerKind } from "@/components/runners/runners-view";
import { PageFrame, PropGroup, PropRow } from "@/components/shell/page-frame";
import { Button, buttonVariants } from "@/components/ui/button";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";
import { TaskThread } from "@/task/task-thread";
import { useTaskLog } from "@/task/use-task-log";

import { activityText, stateTone, taskStateText } from "./task-words";

type Task = RouterOutputs["tasks"]["get"];

/** Records how long the fold of the default view took, for ADR 0036's render bar (the e2e reads it). */
const recordFold = (ms: number, messages: number): void => {
  Reflect.set(globalThis, "__ostraFold", { ms, messages, at: performance.now() });
};

const Properties = ({ task, tokens, context, onTakeOver, takingOver }: {
  readonly task: Task;
  readonly tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean };
  readonly context: { readonly used: number; readonly size: number } | null;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
}) => {
  const input = Math.max(tokens.inputTokens, task.session?.inputTokens ?? 0);
  const output = Math.max(tokens.outputTokens, task.session?.outputTokens ?? 0);
  return (
    <div data-testid="task-properties">
      <PropGroup title={t("taskPage.properties")}>
        <PropRow label={t("taskPage.status")}>
          <Status tone={stateTone(task.state)}>{taskStateText(task.state)}</Status>
        </PropRow>
        <PropRow label={t("taskPage.driver")}>
          <span className="truncate">{task.driver?.name ?? "–"}</span>
          {task.capabilities.takeOver ? (
            <Button variant="link" size="sm" onClick={onTakeOver} disabled={takingOver}>{t("taskPage.takeOver")}</Button>
          ) : null}
        </PropRow>
        <PropRow label={t("taskPage.runner")}>
          {task.runner === null ? <span className="text-faint">{t("taskPage.noRunner")}</span> : (
            <>
              {task.runner.kind === "personal" ? <LaptopIcon /> : <ServerIcon />}
              <span className="truncate font-mono text-sm">{task.runner.name}</span>
            </>
          )}
        </PropRow>
        {task.runner === null ? null : (
          <div className="pb-1 pl-[104px]"><RunnerKind runner={task.runner} /></div>
        )}
        <PropRow label={t("taskPage.tokens")}>
          <span className="font-mono text-sm" data-testid="task-tokens">
            {formatTokens(input)} {t("taskPage.in")} · {formatTokens(output)} {t("taskPage.out")}
          </span>
        </PropRow>
        {context === null ? null : (
          <PropRow label={t("taskPage.context")}>
            <span className="inline-block h-1 w-20 overflow-hidden rounded-sm bg-line-2" aria-hidden>
              <i className="block h-full bg-muted" style={{ width: `${String(Math.min(100, Math.round((context.used / Math.max(1, context.size)) * 100)))}%` }} />
            </span>
            <span className="font-mono text-sm text-muted">{formatTokens(context.used)} / {formatTokens(context.size)}</span>
          </PropRow>
        )}
      </PropGroup>
      <PropGroup title={t("taskPage.code")}>
        {task.repos.map((repo) => {
          const href = repo.pr === null ? null : safeHref(repo.pr.url);
          return (
            <div key={repo.repoId}>
              <PropRow label={t("taskPage.repo")}><span className="truncate font-mono text-sm">{repo.fullName}</span></PropRow>
              <PropRow label={t("taskPage.branch")}>
                <GitBranchIcon />
                <span className="truncate font-mono text-sm" title={repo.branchName}>{repo.branchName}</span>
              </PropRow>
              <PropRow label={t("taskPage.pr")}>
                {repo.pr === null || href === null ? <span className="text-faint">{t("taskPage.noPr")}</span> : (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-teal hover:underline" data-testid="pr-link">
                    <GitPullRequestIcon /> #{repo.pr.number}
                  </a>
                )}
              </PropRow>
            </div>
          );
        })}
      </PropGroup>
    </div>
  );
};

/**
 * The task page (ADR 0036, F-023, F-025): the live thread, the properties panel, Stop and the PR
 * link. Stop is optimistic and confirmed by the stream's change notice.
 */
export const TaskView = ({ taskId }: { readonly taskId: string }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const task = useQuery(trpc.tasks.get.queryOptions({ taskId }));
  const me = useQuery(trpc.me.get.queryOptions());
  const members = useQuery(trpc.organization.members.queryOptions());
  const project = useQuery({ ...trpc.projects.get.queryOptions({ projectId: task.data?.projectId ?? "" }), enabled: task.data !== undefined });
  const log = useTaskLog(taskId);
  const view = useMemo(() => deriveTaskState(log.state.events), [log.state.events]);
  const [stopping, setStopping] = useState(false);

  const getKey = trpc.tasks.get.queryKey({ taskId });
  const stop = useMutation(
    trpc.tasks.stop.mutationOptions({
      onMutate: () => { setStopping(true); },
      onError: () => { setStopping(false); },
      onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }),
    }),
  );
  const takeOver = useMutation(trpc.tasks.takeOver.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }) }));

  const names = useMemo(() => new Map<string, string>((members.data ?? []).map((member) => [member.memberId, member.name] as const)), [members.data]);
  const memberName = useCallback((memberId: string) => names.get(memberId) ?? t("taskPage.someone"), [names]);

  const data = task.data;
  if (task.error !== null) {
    return (
      <PageFrame crumbs={[{ label: t("shell.tasks") }]}>
        <p role="alert" className="text-red">{errorText(task.error)}</p>
      </PageFrame>
    );
  }
  if (data === undefined) return <PageFrame crumbs={[{ label: t("shell.tasks") }]}>{null}</PageFrame>;

  const stopped = data.state === "stopped";
  const prs = data.repos.flatMap((repo) => (repo.pr === null ? [] : [{ ...repo.pr, href: safeHref(repo.pr.url) }]));
  const summary = data.needsYou.find((item) => item.summary !== null)?.summary ?? null;
  const running = view.turnRunning || data.state === "running" || data.state === "preparing";

  return (
    <PageFrame
      padded={false}
      crumbs={[
        { label: project.data?.name ?? "", href: `/projects/${data.projectId}` },
        { label: t("shell.tasks"), href: `/projects/${data.projectId}` },
        { label: data.key },
      ]}
      actions={
        <>
          {prs.map((pr) =>
            pr.href === null ? null : (
              <a key={pr.number} href={pr.href} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
                <GitPullRequestIcon /> {t("taskPage.prButton", { n: pr.number })}
              </a>
            ),
          )}
          {data.capabilities.stop && !stopped ? (
            <Button data-action="stop" onClick={() => { stop.mutate({ taskId: taskIdSchema.parse(taskId) }); }} disabled={stopping || stop.isPending}>
              <SquareIcon /> {stopping ? t("taskPage.stopping") : t("taskPage.stop")}
            </Button>
          ) : null}
        </>
      }
      properties={
        <Properties
          task={data}
          tokens={view.tokens}
          context={view.context}
          takingOver={takeOver.isPending}
          onTakeOver={() => { takeOver.mutate({ taskId: taskIdSchema.parse(taskId) }); }}
        />
      }
    >
      <div className="flex min-h-full flex-col px-4 pb-4 pt-6 sm:px-10 sm:pt-7 xl:h-full">
        <div className="shrink-0">
          <div className="font-mono text-sm text-faint">{data.key} · {data.source === "prompt" ? t("taskPage.fromPrompt") : t("taskPage.fromTicket")}</div>
          <h1 className="page-title my-1.5 break-words">{data.title}</h1>
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted" data-testid="task-doing">
            <Status tone={stateTone(data.state)}>{stopping && !stopped ? t("taskPage.stopping") : taskStateText(data.state)}</Status>
            <span>{activityText(view.activity)}</span>
            {log.state.connection === "reconnecting" ? <span className="text-amber">{t("taskPage.reconnecting")}</span> : null}
          </p>
          {stop.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(stop.error)}</p>}
          {data.group === "needs-you" ? (
            <div data-testid="needs-you" className="mt-4 border-l-2 border-amber pl-3">
              <div className="flex items-center gap-2 font-medium text-amber"><HandIcon className="size-[14px]" /> {t("taskPage.needsYou")}</div>
              <p className="whitespace-pre-wrap text-body">{summary ?? data.reason ?? t("taskPage.needsYouDefault")}</p>
            </div>
          ) : null}
          <div className={cn("mt-5 border-b border-line")} />
        </div>
        {log.error === null ? null : <p role="alert" className="mt-3 text-red">{log.error}</p>}
        <TaskThread
          taskId={taskId}
          log={log.state}
          memberId={me.data?.memberId ?? null}
          memberName={memberName}
          canSend={data.capabilities.send}
          running={running}
          hasEarlier={log.state.olderBefore !== null}
          loadEarlier={log.loadEarlier}
          onFold={recordFold}
        />
      </div>
    </PageFrame>
  );
};
