"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, GitPullRequestIcon, LinkIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { clientMessageIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";

import { servicesWaitText } from "@/components/projects/environment-services-words";
import { RunnerKind } from "@/components/runners/runners-view";
import { PageFrame, PropGroup, PropRow } from "@/components/shell/page-frame";
import { initials } from "@/components/shell/user-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { NeedsYou } from "@/components/ui/needs-you";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatDuration, formatElapsed, formatTokens } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import type { RouterOutputs } from "@/lib/trpc";
import { safeHref } from "@/task/renderers";
import { TaskThread } from "@/task/task-thread";
import { useTaskLog } from "@/task/use-task-log";

import { AgentGot, LimitBlock, MergedHint, RestoreConflict, TicketLine, TicketProperties, boxText, composerInputOf, composerMode, idleHeader, limitStateOf, spendText } from "./task-ticket";
import { headerActivity, shownInThread, stateTone, taskStateLine } from "./task-words";
import { ApprovalCard, PlanBlock, QuestionCard, TicketClosedBlock, WatcherBar, approvalReceipt } from "./task-answers";
import { ChangesTab } from "./task-changes/changes-tab";
import { ChecksTab, checksMarkerOf } from "./task-checks/checks-tab";
import { ChecksTabMarker } from "./task-checks/task-checks";
import { ReasoningRow, TaskEffortRow } from "./task-effort";
import type { TaskEffort } from "./task-effort";
import { TakeItLocal } from "./take-it-local";
import type { LocalLoad } from "./take-it-local";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { useRouter, useSearchParams } from "next/navigation";

type Task = RouterOutputs["tasks"]["get"];

type TaskTab = "activity" | "changes" | "checks";

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
const Properties = ({ task, tokens, reasoningTokens, context, now, onTakeOver, takingOver, ticket, effort }: {
  readonly task: Task;
  /** F-137: the Effort row, built by the view (it holds the change's mutation). */
  readonly effort: ReactNode;
  readonly tokens: { readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean };
  /** F-137: the reasoning tokens inside `out`, from the turns' usage. */
  readonly reasoningTokens: number;
  readonly context: { readonly used: number; readonly size: number } | null;
  readonly now: number;
  readonly onTakeOver: () => void;
  readonly takingOver: boolean;
  /** The Ticket and On Linear groups (ticket 36). */
  readonly ticket: ReactNode;
}) => {
  const usage = task.usage?.totals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, spentMicroUsd: null, agentMs: 0, estimated: false };
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
        <PropRow label={t("taskAnswers.usage.profile")}>
          {task.agent === null ? <span className="text-faint">{t("taskAnswers.usage.none")}</span> : <span className="truncate" data-testid="task-profile">{task.agent.name}</span>}
        </PropRow>
        {task.agent === null ? null : (
          <>
            <PropRow label={t("taskPage.agent")}><span className="truncate">{task.agent.agentName}</span></PropRow>
            {task.agent.model === null ? null : (
              <PropRow label={t("taskPage.model")}><span className="truncate">{task.agent.model.name}</span></PropRow>
            )}
          </>
        )}
        {effort}
        <PropRow label={t("taskPage.runner")}>
          {task.runner === null ? <span className="text-faint">{t("taskPage.noRunner")}</span> : <Mono>{task.runner.name}</Mono>}
        </PropRow>
        {task.runner === null ? null : (
          <div className="pb-1.5 pl-[104px]"><RunnerKind runner={task.runner} /></div>
        )}
        <PropRow label={t("taskPage.tokens")}>
          <Mono>
            <span data-testid="task-tokens">{usage.estimated ? "≈ " : ""}{formatTokens(Math.max(input, usage.inputTokens))} {t("taskPage.in")} · {formatTokens(Math.max(output, usage.outputTokens))} {t("taskPage.out")}</span>
          </Mono>
          {/* F-089: a call whose endpoint reported no usage was estimated by the key proxy, and the count says so. */}
          {tokens.estimated ? (
            <span data-testid="task-tokens-estimated" className="truncate text-faint" title={t("taskPage.estimatedHelp")}>
              {t("taskPage.estimated")}
            </span>
          ) : null}
        </PropRow>
        <ReasoningRow tokens={reasoningTokens} />
        <PropRow label={t("taskAnswers.usage.cache")}>
          <Mono><span data-testid="task-cache">{formatTokens(usage.cacheReadTokens)} {t("taskAnswers.usage.read")} · {formatTokens(usage.cacheWriteTokens)} {t("taskAnswers.usage.write")}</span></Mono>
        </PropRow>
        {context === null ? null : (
          <PropRow label={t("taskPage.context")}>
            <span className="inline-block h-1 w-[60px] shrink-0 overflow-hidden rounded-sm bg-line-2" aria-hidden>
              <i className="block h-full bg-muted" style={{ width: `${String(Math.min(100, Math.round((context.used / Math.max(1, context.size)) * 100)))}%` }} />
            </span>
            <Mono className="text-muted">{formatTokens(context.used)} / {formatTokens(context.size)}</Mono>
          </PropRow>
        )}
        {task.box === null ? null : <PropRow label={t("taskPage.box.label")}><span className="truncate">{boxText(task.box, now)}</span></PropRow>}
        <PropRow label={t("taskPage.spend")}>
          <Mono className={task.spend.reached ? "text-amber" : ""}>{spendText(task.spend)}</Mono>
        </PropRow>
        <PropRow label={t("taskAnswers.usage.agentTime")}><Mono><span data-testid="task-agent-time">{formatDuration(usage.agentMs)}</span></Mono></PropRow>
        <PropRow label={t("taskPage.time")}><Mono>{formatElapsed(task.createdAt, now)}</Mono></PropRow>
      </PropGroup>
      {task.taskRules.length === 0 ? null : (
        <PropGroup title={t("taskAnswers.usage.rules")}>
          {task.taskRules.map((rule) => (
            <div key={rule.ruleId} className="flex h-[26px] items-center gap-2 text-[12.5px]" data-testid="task-rule">
              <span className="min-w-0 flex-1 truncate font-mono text-text">{rule.tool} {rule.pattern}</span>
              <span className="shrink-0 text-xs text-faint">{t("taskAnswers.usage.fromTask", { name: rule.createdBy?.name ?? t("taskPage.someone") })}</span>
            </div>
          ))}
        </PropGroup>
      )}
      {ticket}
      <PropGroup title={t("taskPage.code")}>
        {task.repos.map((repo) => {
          const href = repo.pr === null ? null : safeHref(repo.pr.url);
          return (
            <div key={repo.repoId}>
              <PropRow label={t("taskPage.repo")}><Mono>{repo.fullName}</Mono></PropRow>
              <PropRow label={t("taskPage.branch")}>
                <span className="truncate font-mono text-ui" title={repo.branchName}>{repo.branchName}</span>
              </PropRow>
              {repo.pullRequests.filter((pr) => pr.number !== repo.pr?.number).map((pr) => (
                <PropRow key={pr.number} label={t("taskPage.pr")}>
                  <a href={safeHref(pr.url) ?? "#"} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline" data-testid="pr-earlier">#{pr.number}</a>
                  <span className="text-faint">·</span>
                  <span className="text-ui text-muted">{pr.state}</span>
                </PropRow>
              ))}
              <PropRow label={t("taskPage.pr")}>
                {repo.pr === null || href === null ? <span className="text-faint">{t("taskPage.noPr")}</span> : (
                  <>
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline" data-testid="pr-link">
                      #{repo.pr.number}
                    </a>
                    <span className="text-faint">·</span>
                    <span className={cn("text-ui", repo.pr.state === "merged" ? "text-green" : repo.pr.state === "closed" ? "text-faint" : "text-muted")} data-pr-state={repo.pr.state}>
                      {t(`taskPage.prState.${repo.pr.state}`)}
                    </span>
                  </>
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
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TaskTab = tabParam === "changes" || tabParam === "checks" ? tabParam : "activity";
  const selectTab = useCallback((next: TaskTab) => {
    const query = new URLSearchParams(params.toString());
    if (next === "activity") query.delete("tab");
    else query.set("tab", next);
    const search = query.toString();
    router.replace(search === "" ? `/tasks/${taskId}` : `/tasks/${taskId}?${search}`, { scroll: false });
  }, [params, router, taskId]);
  const [localOpened, setLocalOpened] = useState(false);
  const local = useQuery(trpc.tasks.local.queryOptions(localOpened ? { taskId } : skipToken));
  const checksMarker = useQuery({ ...trpc.tasks.checks.queryOptions({ taskId }), refetchInterval: 15_000 });

  const getKey = trpc.tasks.get.queryKey({ taskId });
  const stop = useMutation(
    trpc.tasks.stop.mutationOptions({
      onMutate: () => { setStopping(true); },
      onError: () => { setStopping(false); },
      onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }),
    }),
  );
  const takeOver = useMutation(trpc.tasks.takeOver.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }) }));
  const setEffort = useMutation(trpc.tasks.setEffort.mutationOptions({ onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }) }));
  const settle = { onSettled: () => queryClient.invalidateQueries({ queryKey: getKey }) };
  const reopen = useMutation(trpc.tasks.reopen.mutationOptions(settle));
  const retrySync = useMutation(trpc.tasks.retrySync.mutationOptions(settle));
  const dismiss = useMutation(trpc.tasks.dismissNeedsYou.mutationOptions(settle));
  const createTicket = useMutation(trpc.tasks.createTicket.mutationOptions(settle));
  const boards = useQuery(trpc.boards.get.queryOptions(task.data === undefined ? skipToken : { projectId: task.data.projectId }));

  const names = useMemo(() => new Map<string, string>((members.data ?? []).map((member) => [member.memberId, member.name] as const)), [members.data]);
  const memberName = useCallback((memberId: string) => names.get(memberId) ?? t("taskPage.someone"), [names]);
  const needsYou = task.data?.needsYou;
  const approvalSummary = useCallback(
    (approvalId: string) => needsYou?.find((item) => item.approvalId === approvalId)?.summary ?? null,
    [needsYou],
  );
  // Ticket 43: the open approvals and questions answered in the thread, from `tasks.get`.
  const approvals = task.data?.approvals;
  const questions = task.data?.questions;
  const agentName = task.data?.agent?.agentName ?? t("task.agent");
  const projectName = project.data?.name ?? "";
  const driverName = task.data?.driver?.name ?? null;
  const isDriver = task.data !== undefined && task.data.driver !== null && task.data.driver.memberId === me.data?.memberId;
  const takeOverNow = useCallback(() => { takeOver.mutate({ taskId }); }, [takeOver, taskId]);
  const approvalCard = useCallback(
    (approvalId: string): ReactNode => {
      const approval = approvals?.find((one) => one.approvalId === approvalId);
      if (approval === undefined || (approval.state !== "open" && !approval.answerableAnyway)) return null;
      const othersOpen = (approvals ?? []).filter((one) => one.state === "open" && one.approvalId !== approvalId).length;
      return <ApprovalCard key={approvalId} taskId={taskId} approval={approval} agent={agentName} project={projectName} othersOpen={othersOpen} />;
    },
    [approvals, taskId, agentName, projectName],
  );
  const receiptOf = useCallback(
    (approvalId: string): string | null => {
      const approval = approvals?.find((one) => one.approvalId === approvalId);
      return approval === undefined ? null : approvalReceipt(approval);
    },
    [approvals],
  );
  const questionCard = useCallback(
    (questionId: string): ReactNode => {
      const question = questions?.find((one) => one.questionId === questionId);
      return question === undefined ? null : (
        <QuestionCard taskId={taskId} question={question} agent={agentName} isDriver={isDriver} driver={driverName} onTakeOver={takeOverNow} takingOver={takeOver.isPending} />
      );
    },
    [questions, taskId, agentName, isDriver, driverName, takeOverNow, takeOver.isPending],
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
  // F-137: the level from the newest `effort.changed` on the stream, else `tasks.get`'s.
  const effort: TaskEffort = { level: view.effort ?? data.effort.level, levels: data.effort.levels.map((one) => one.level), runningTurn: view.runningEffort };
  const stateText = stopping && !stopped ? t("taskPage.stopping") : taskStateLine(data.state, data.reason);
  const activity = idleHeader(data.box, now) ?? headerActivity(view.activity);
  const mode = composerMode(composerInputOf(data));
  const conflict = data.needsYou.find((item) => item.reason === "restore_conflict");
  const ticketClosed = data.needsYou.find((item) => item.reason === "ticket_closed");
  const sessionGoing = data.session !== null && ["starting", "running", "waiting", "idle"].includes(data.session.state);
  const changedFiles = data.repos.length;
  const localLoad: LocalLoad = local.data !== undefined
    ? { kind: "ready", local: { checkoutLine: local.data.checkoutCommand, loginLine: local.data.loginCommand, hasCliSession: local.data.hasCliSession, repos: local.data.repos.map((repo) => ({ fullName: repo.fullName, branch: repo.branch, mergedPr: repo.pr?.state === "merged" ? repo.pr.number : null })) } }
    : local.error !== null
      ? { kind: "error", message: errorText(local.error) ?? t("errors.unknown") }
      : { kind: "loading" };
  const firstBoard = boards.data?.boards[0];
  const ticketGroups = (
    <TicketProperties
      task={{ ticket: data.ticket, sync: data.sync, canRetry: data.capabilities.retrySync }}
      now={now}
      retry={{ run: () => { retrySync.mutate({ taskId }); }, pending: retrySync.isPending }}
      createTicket={
        data.source === "prompt" && firstBoard !== undefined
          ? { run: () => { createTicket.mutate({ taskId, boardId: firstBoard.id }); }, pending: createTicket.isPending, error: errorText(createTicket.error) }
          : null
      }
    />
  );
  // A member who isn't the driver sees who is, and how to take over, where the composer would be.
  const notDriver =
    data.capabilities.send || !data.capabilities.takeOver || finished ? undefined : (
      <WatcherBar driver={data.driver?.name ?? null} onTakeOver={takeOverNow} takingOver={takeOver.isPending} />
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
          <TakeItLocal pushed={data.repos.some((repo) => repo.headSha !== null)} load={localLoad} onOpen={() => { setLocalOpened(true); }} />
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
          reasoningTokens={view.reasoningTokens}
          context={view.context}
          now={now}
          takingOver={takeOver.isPending}
          onTakeOver={() => { takeOver.mutate({ taskId }); }}
          ticket={ticketGroups}
          effort={
            <TaskEffortRow
              effort={effort}
              viewer={{ driver: data.capabilities.setEffort, canTakeOver: data.capabilities.takeOver, finished }}
              pending={setEffort.isPending}
              error={setEffort.error === null ? null : errorText(setEffort.error)}
              onChange={(level) => { setEffort.mutate({ taskId, level }); }}
              onTakeOver={takeOverNow}
            />
          }
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
          {data.waiting?.kind === "no-runner" && data.waiting.reason.code === "needs-services-runner" ? (
            <p className="mt-1.5 text-ui text-muted" data-testid="task-dispatch-note">{servicesWaitText(data.waiting.reason.online)}</p>
          ) : null}
          {data.ticket === null ? null : <TicketLine ticket={data.ticket} />}
          {data.source === "ticket" ? <AgentGot files={data.contextFiles} /> : null}
          {stop.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(stop.error)}</p>}
          <LimitBlock
            task={limitStateOf(data)}
            reopen={{
              run: () => { reopen.mutate({ taskId, clientMessageId: clientMessageIdSchema.parse(crypto.randomUUID()) }); },
              pending: reopen.isPending,
              error: errorText(reopen.error),
            }}
          />
          {ticketClosed === undefined ? null : <TicketClosedBlock taskId={taskId} summary={ticketClosed.summary} />}
          {conflict === undefined ? null : (
            <RestoreConflict
              savedWorkUrl={null}
              canAnswer={data.driver?.memberId === me.data?.memberId}
              dismiss={{ run: () => { dismiss.mutate({ taskId, itemId: conflict.id }); }, pending: dismiss.isPending }}
            />
          )}
          {data.group === "needs-you" && !shownInThread(data.reason) && data.limit === null && data.reason !== "crashed" && conflict === undefined && ticketClosed === undefined && data.reason !== "plan" && data.reason !== "approval" && data.reason !== "question" ? (
            <NeedsYou title={t("taskPage.needsYou")} className="mt-4">
              <p className="whitespace-pre-wrap">{summary ?? t("taskPage.needsYouDefault")}</p>
            </NeedsYou>
          ) : null}
          <UnderlineTabs
            className="mt-4"
            label={t("taskAnswers.tabs.activity")}
            idPrefix="task-tab"
            selected={tab}
            onSelect={selectTab}
            tabs={[
              { id: "activity", label: t("taskAnswers.tabs.activity") },
              { id: "changes", label: t("taskAnswers.tabs.changes"), extra: changedFiles === 0 ? null : <span className="text-faint">{changedFiles}</span> },
              { id: "checks", label: t("taskAnswers.tabs.checks"), extra: <ChecksTabMarker marker={checksMarkerOf(checksMarker.data)} /> },
            ]}
          />
        </div>
        {log.error === null ? null : <p role="alert" className="mt-3 text-red">{log.error}</p>}
        {tab === "changes" ? (
          <div className="min-h-0 flex-1" id="task-tab-changes">
            <ChangesTab taskId={taskId} agent={agentName} driver={driverName} isDriver={isDriver} running={running} steersMidTurn={data.capabilities.steersMidTurn} sessionGoing={sessionGoing} onTakeOver={takeOverNow} onSeeActivity={() => { selectTab("activity"); }} />
          </div>
        ) : tab === "checks" ? (
          <div className="min-h-0 flex-1" id="task-tab-checks">
            <ChecksTab taskId={taskId} projectId={data.projectId} agent={agentName} driver={driverName} isDriver={isDriver} running={running} sessionGoing={sessionGoing} now={now} onTakeOver={takeOverNow} onSeeActivity={() => { selectTab("activity"); }} />
          </div>
        ) : (
        <TaskThread
          taskId={taskId}
          log={log.state}
          memberId={me.data?.memberId ?? null}
          memberName={memberName}
          canSend={data.capabilities.send}
          canReopen={mode.kind === "reopen"}
          composerHint={mode.kind === "send" || mode.kind === "reopen" ? mode.hint : null}
          {...(mode.kind === "merged" ? { instead: <MergedHint inboxHref={data.ticket === null ? null : `/projects/${data.projectId}/inbox?ticket=${encodeURIComponent(data.ticket.key)}`} /> } : {})}
          canInterrupt={data.capabilities.interrupt}
          running={running}
          agent={{ name: data.agent?.agentName ?? t("task.agent"), model: data.agent?.model?.name ?? null }}
          approvalSummary={approvalSummary}
          approvalCard={approvalCard}
          approvalReceipt={receiptOf}
          questionCard={questionCard}
          tail={data.plan === null ? null : <PlanBlock key={`${data.plan.turnId}:${String(data.plan.proposedAt)}`} taskId={taskId} plan={data.plan} agent={agentName} isDriver={isDriver} driver={driverName} onTakeOver={takeOverNow} takingOver={takeOver.isPending} />}
          {...(notDriver === undefined ? {} : { notDriver })}
          hasEarlier={log.state.olderBefore !== null}
          loadEarlier={log.loadEarlier}
          onFold={recordFold}
        />
        )}
      </div>
    </PageFrame>
  );
};
