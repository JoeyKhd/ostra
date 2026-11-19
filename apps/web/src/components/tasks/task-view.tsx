"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, GitPullRequestIcon, LinkIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { TaskId } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";

import { RunnerKind } from "@/components/runners/runners-view";
import { PageFrame, PropGroup, PropRow } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { NeedsYou } from "@/components/ui/needs-you";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatElapsed, formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";
import { TaskThread } from "@/task/task-thread";
import { useTaskLog } from "@/task/use-task-log";

import { headerActivity, shownInThread, stateTone, taskStateLine } from "./task-words";

type Task = RouterOutputs["tasks"]["get"];

/** Records how long the fold of the default view took, for ADR 0036's render bar (the e2e reads it). */
const recordFold = (ms: number, messages: number): void => {
  Reflect.set(globalThis, "__ostraFold", { ms, messages, at: performance.now() });
};

/** The time now, ticking twice a minute: the elapsed time in the header and the panel. */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { clearInterval(timer); };
  }, []);
  return now;
};

/** The ` · ` between facts on a line, in `--faint`. */
const Sep = () => <span aria-hidden className="text-faint">·</span>;

const Mono = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span className={cn("truncate font-mono text-ui", className)}>{children}</span>
);

/** The 18px avatar beside the driver's name: the only marker a value may carry besides the status dot. */
const Avatar = ({ name }: { readonly name: string }) => (
  <span aria-hidden className="inline-grid size-[18px] shrink-0 place-items-center rounded-full bg-line-2 text-[9.5px] font-semibold text-text">
    {initials(name)}
  </span>
);

/** The ghost icon button left of the PR: copies the task's address. */
const CopyLink = () => {
  const [copied, setCopied] = useState(false);
  const label = copied ? t("taskPage.linkCopied") : t("taskPage.copyLink");
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      data-action="copy-link"
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
    </Button>
  );
};

/**
 * The properties panel (task.md, "Properties panel"): what describes the task and doesn't change turn
 * to turn. Values carry no icons, so they all start at one x; the status dot and the driver's avatar
 * are the only markers. Spend (F-084) and the Changes group (F-027) come later.
 */
const Properties = ({ task, tokens, context, now, onTakeOver, takingOver }: {
  readonly task: Task;
  readonly tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean };
  readonly context: { readonly used: number; readonly size: number } | null;
  readonly now: number;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
}) => {
  const input = Math.max(tokens.inputTokens, task.session?.inputTokens ?? 0);
  const output = Math.max(tokens.outputTokens, task.session?.outputTokens ?? 0);
  return (
    <div data-testid="task-properties">
      <PropGroup title={t("taskPage.properties")}>
        <PropRow label={t("taskPage.status")}>
          <Status tone={stateTone(task.state)} className="min-w-0">
            <span className="truncate">{taskStateLine(task.state, task.reason)}</span>
          </Status>
        </PropRow>
        <PropRow label={t("taskPage.driver")}>
          {task.driver === null ? <span className="text-faint">–</span> : (
            <>
              <Avatar name={task.driver.name} />
              <span className="truncate">{task.driver.name}</span>
            </>
          )}
          {task.capabilities.takeOver ? (
            <>
              {task.driver === null ? null : <Sep />}
              <Button variant="link" className="text-ui font-normal" onClick={onTakeOver} disabled={takingOver} data-action="take-over">{t("taskPage.takeOver")}</Button>
            </>
          ) : null}
        </PropRow>
        {task.agent === null ? null : (
          <>
            <PropRow label={t("taskPage.agent")}><span className="truncate">{task.agent.agentName}</span></PropRow>
            {task.agent.model === null ? null : (
              <PropRow label={t("taskPage.model")}><span className="truncate">{task.agent.model.name}</span></PropRow>
            )}
          </>
        )}
        <PropRow label={t("taskPage.runner")}>
          {task.runner === null ? <span className="text-faint">{t("taskPage.noRunner")}</span> : <Mono>{task.runner.name}</Mono>}
        </PropRow>
        {task.runner === null ? null : (
          <div className="pb-1.5 pl-[104px]"><RunnerKind runner={task.runner} /></div>
        )}
        <PropRow label={t("taskPage.tokens")}>
          <Mono>
            <span data-testid="task-tokens">{formatTokens(input)} {t("taskPage.in")} · {formatTokens(output)} {t("taskPage.out")}</span>
          </Mono>
        </PropRow>
        {context === null ? null : (
          <PropRow label={t("taskPage.context")}>
            <span className="inline-block h-1 w-[60px] shrink-0 overflow-hidden rounded-sm bg-line-2" aria-hidden>
              <i className="block h-full bg-muted" style={{ width: `${String(Math.min(100, Math.round((context.used / Math.max(1, context.size)) * 100)))}%` }} />
            </span>
            <Mono className="text-muted">{formatTokens(context.used)} / {formatTokens(context.size)}</Mono>
          </PropRow>
        )}
        <PropRow label={t("taskPage.time")}><Mono>{formatElapsed(task.createdAt, now)}</Mono></PropRow>
      </PropGroup>
      <PropGroup title={t("taskPage.code")}>
        {task.repos.map((repo) => {
          const href = repo.pr === null ? null : safeHref(repo.pr.url);
          return (
            <div key={repo.repoId}>
              <PropRow label={t("taskPage.repo")}><Mono>{repo.fullName}</Mono></PropRow>
              <PropRow label={t("taskPage.branch")}>
                <span className="truncate font-mono text-ui" title={repo.branchName}>{repo.branchName}</span>
              </PropRow>
              <PropRow label={t("taskPage.pr")}>
                {repo.pr === null || href === null ? <span className="text-faint">{t("taskPage.noPr")}</span> : (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline" data-testid="pr-link">
                    #{repo.pr.number}
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
 * The task page (task.md; ADR 0036, F-023, F-025): the header, the live thread with its composer, and
 * the properties panel. Stop is optimistic and confirmed by the stream's change notice.
 */
export const TaskView = ({ taskId }: { readonly taskId: TaskId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const task = useQuery(trpc.tasks.get.queryOptions({ taskId }));
  const me = useQuery(trpc.me.get.queryOptions());
  const members = useQuery(trpc.organization.members.queryOptions());
  const project = useQuery(trpc.projects.get.queryOptions(task.data === undefined ? skipToken : { projectId: task.data.projectId }));
  const log = useTaskLog(taskId);
  const view = useMemo(() => deriveTaskState(log.state.events), [log.state.events]);
  const [stopping, setStopping] = useState(false);
  const now = useNow();

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
  const needsYou = task.data?.needsYou;
  const approvalSummary = useCallback(
    (approvalId: string) => needsYou?.find((item) => item.approvalId === approvalId)?.summary ?? null,
    [needsYou],
  );

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
  const finished = stopped || data.state === "merged" || data.state === "done";
  const prs = data.repos.flatMap((repo) => (repo.pr === null ? [] : [{ ...repo.pr, href: safeHref(repo.pr.url) }]));
  const summary = data.needsYou.find((item) => item.summary !== null)?.summary ?? null;
  const running = view.turnRunning || data.state === "running" || data.state === "preparing";
  const stateText = stopping && !stopped ? t("taskPage.stopping") : taskStateLine(data.state, data.reason);
  const activity = headerActivity(view.activity);
  // A member who isn't the driver sees who is, and how to take over, where the composer would be.
  const notDriver =
    data.capabilities.send || !data.capabilities.takeOver || finished ? undefined : (
      <span className="flex flex-wrap items-center gap-1">
        {data.driver === null ? t("task.composer.noDriver") : t("task.composer.notDriver", { name: data.driver.name })}
        <Button variant="link" className="text-sm font-normal" onClick={() => { takeOver.mutate({ taskId }); }} disabled={takeOver.isPending}>
          {t("taskPage.takeOver")}
        </Button>
      </span>
    );

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
          <CopyLink />
          {prs.map((pr) =>
            pr.href === null ? null : (
              <a key={pr.number} href={pr.href} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
                <GitPullRequestIcon /> {t("taskPage.prButton", { n: pr.number })}
              </a>
            ),
          )}
          {data.capabilities.stop && !stopped ? (
            <Button data-action="stop" onClick={() => { stop.mutate({ taskId }); }} disabled={stopping || stop.isPending}>
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
          now={now}
          takingOver={takeOver.isPending}
          onTakeOver={() => { takeOver.mutate({ taskId }); }}
        />
      }
    >
      <div className="flex min-h-full flex-col px-4 pb-5 pt-6 sm:px-10 sm:pt-7 xl:h-full">
        <div className="shrink-0">
          <div className="font-mono text-sm text-faint">{data.key} · {data.source === "prompt" ? t("taskPage.fromPrompt") : t("taskPage.fromTicket")}</div>
          <h1 className="page-title my-1.5 break-words">{data.title}</h1>
          <p className="flex flex-wrap items-center gap-x-2 text-body" data-testid="task-doing">
            <Status tone={stateTone(data.state)}><span className="font-medium text-text">{stateText}</span></Status>
            {activity === "" ? null : <><Sep /><span className="text-muted">{activity}</span></>}
            <Sep />
            <span className="text-muted">
              {t("taskPage.started", { age: formatElapsed(data.createdAt, now) })}
              {data.runner === null ? null : <> {t("taskPage.on")} <span className="font-mono text-ui text-faint">{data.runner.name}</span></>}
            </span>
            {log.state.connection === "reconnecting" ? <><Sep /><span className="text-muted">{t("taskPage.reconnecting")}</span></> : null}
          </p>
          {stop.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(stop.error)}</p>}
          {data.group === "needs-you" && !shownInThread(data.reason) ? (
            <NeedsYou title={t("taskPage.needsYou")} className="mt-4">
              <p className="whitespace-pre-wrap">{summary ?? t("taskPage.needsYouDefault")}</p>
            </NeedsYou>
          ) : null}
          <div className="mt-5 border-b border-line" />
        </div>
        {log.error === null ? null : <p role="alert" className="mt-3 text-red">{log.error}</p>}
        <TaskThread
          taskId={taskId}
          log={log.state}
          memberId={me.data?.memberId ?? null}
          memberName={memberName}
          canSend={data.capabilities.send}
          canInterrupt={data.capabilities.interrupt}
          running={running}
          agent={{ name: data.agent?.agentName ?? t("task.agent"), model: data.agent?.model?.name ?? null }}
          approvalSummary={approvalSummary}
          {...(notDriver === undefined ? {} : { notDriver })}
          hasEarlier={log.state.olderBefore !== null}
          loadEarlier={log.loadEarlier}
          onFold={recordFold}
        />
      </div>
    </PageFrame>
  );
};
