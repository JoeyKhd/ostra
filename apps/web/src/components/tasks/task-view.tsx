"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindowIcon, CheckIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, LinkIcon, MessageSquareIcon, Minimize2Icon, PanelRightIcon, ScanSearchIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { approvalIdSchema, clientMessageIdSchema, questionIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";

import { servicesWaitText } from "@/components/projects/environment-services-words";
import { RunnerKind } from "@/components/runners/runners-view";
import { useProvideTaskScope } from "@/components/shell/actions/use-scope";
import type { ItemScope, TaskScope } from "@/components/shell/actions/use-scope";
import { TaskMemory } from "@/components/memory/task-memory";
import { PageFrame, PropGroup, PropRow } from "@/components/shell/page-frame";
import { useOptionalShellState } from "@/components/shell/shell-state";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { initials } from "@/components/shell/user-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
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

import { TaskAppSupportLine, TaskAttachmentsGroup } from "./attachments/attachments-group";
import { monthWord } from "./budget-reason";
import { PhoneTaskSections } from "./phone-task-sections";
import { TaskPrs } from "./task-prs";
import { HeldNoKey, KeyRow, NoKeySentence, WhoPicks } from "./no-key";
import { adminNames } from "./no-key-words";
import type { NoKey } from "./no-key";
import { AgentGot, MergedHint, TicketLine, TicketProperties, boxText, composerInputOf, composerMode, idleHeader, limitStateOf, sessionText, SpendCapComposer, SpendValue, trackerName } from "./task-ticket";
import { headerActivity, planRowText, stateTone, taskStateLine } from "./task-words";
import { ApprovalCard, PlanBlock, QuestionCard, WatcherBar, approvalReceipt } from "./task-answers";
import { NeedsYouCards, NeedsYouLive } from "./needs-you-cards";
import { needsOf, questionRepeatsMessage, replyHint } from "./needs-you-card-words";
import type { ReplyHow } from "./needs-you-card-words";
import { ChangesTab } from "./task-changes/changes-tab";
import { EventLogTab } from "./task-event-log/event-log-tab";
import { ChecksTab, checksMarkerOf, checksPropertyOf } from "./task-checks/checks-tab";
import { ChecksTabMarker } from "./task-checks/task-checks";
import { ReasoningRow, TaskEffortRow } from "./task-effort";
import type { TaskEffort } from "./task-effort";
import { TakeItLocal } from "./take-it-local";
import { StartedInLinear } from "@/components/approvals/approval-block";

import { TaskWaiting } from "./task-waiting";
import { PreviewPane } from "./preview-pane";
import { PreviewSteerBar } from "./preview-steer-bar";
import { boxSizeText } from "./task-waiting-words";
import type { LocalLoad } from "./take-it-local";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { Chip } from "@/components/ui/status";
import { DraftView } from "./draft/draft-view";
import { DraftProperties } from "./draft/draft-properties";
import { capOf } from "./review/review-words";
import { CodeHeadRows, RoundsGroup, RoundsInThread, StageLine, statusWithSubState } from "./review/task-rounds";
import { formatClock } from "@/lib/format";
import { useRouter, useSearchParams } from "next/navigation";

type Task = RouterOutputs["tasks"]["get"];

type TaskTab = "activity" | "changes" | "checks" | "events" | "draft";

/** The task kinds that never push (ADR 0028 amended): a refine task, and a review task. */
const readOnlyKind = (kind: Task["kind"]): boolean => kind === "refine" || kind === "review";

/** The wait reasons milestones 3 and 4 word in their own blocks on this page (the waiting line skips them). */
const wordedElsewhere: ReadonlySet<string> = new Set(["needs-services-runner", "provider-not-allowed", "installation-not-linked", "no-provider-for-model"]);

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

/** A PR the top bar links to: the repo's current one, with a safe address. */
type BarPr = { readonly number: number; readonly href: string; readonly state: "open" | "merged" | "closed"; readonly repo: string; readonly draft: boolean };

/** Whether a repo's current PR is a draft (task-checks.md: `git-pull-request-draft`, `#483 · draft`). */
const prIsDraft = (repo: Task["repos"][number]): boolean =>
  repo.pr !== null && repo.pr.state === "open" && repo.pullRequests.some((pr) => pr.number === repo.pr?.number && pr.draft);

const PrStateIcon = ({ state }: { readonly state: BarPr["state"] }) => {
  const className = "size-[15px] shrink-0 stroke-[1.75] text-muted";
  switch (state) {
    case "open":
      return <GitPullRequestIcon aria-hidden className={className} />;
    case "merged":
      return <GitMergeIcon aria-hidden className={className} />;
    case "closed":
      return <GitPullRequestClosedIcon aria-hidden className={className} />;
    default:
      return state satisfies never;
  }
};

/**
 * The top bar's PR buttons (task.md): one per PR. At phone width several collapse into one
 * `PRs · n` button that opens a bottom sheet listing them (m2/phone-task.md, "Top bar"), so the
 * bar never scrolls sideways.
 */
const PrButtons = ({ prs }: { readonly prs: readonly BarPr[] }) => {
  const button = (pr: BarPr, className?: string) => (
    <a key={`${pr.repo}#${String(pr.number)}`} href={pr.href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), className)}>
      {pr.draft ? <GitPullRequestDraftIcon /> : <GitPullRequestIcon />} {t("taskPage.prButton", { n: pr.number })}
    </a>
  );
  if (prs.length < 2) return <>{prs.map((pr) => button(pr))}</>;
  return (
    <>
      {prs.map((pr) => button(pr, "max-sm:hidden"))}
      <Sheet>
        <SheetTrigger asChild>
          <Button className="sm:hidden" data-action="task-prs">
            <GitPullRequestIcon aria-hidden /> {t("taskPage.prsButton", { n: prs.length })}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" title={t("taskPage.prsTitle")} className="px-4 pb-6 pt-4">
          <h2 className="text-ui font-semibold text-text">{t("taskPage.prsTitle")}</h2>
          <ul className="mt-2">
            {prs.map((pr) => (
              <li key={`${pr.repo}#${String(pr.number)}`} className="flex h-10 items-center gap-2 border-b border-line text-ui last:border-b-0">
                <PrStateIcon state={pr.state} />
                <span className="min-w-0 truncate font-mono text-text">{pr.repo}</span>
                <a href={pr.href} target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono text-teal hover:underline">#{pr.number}</a>
                <span className="ml-auto shrink-0 text-muted">{t(`taskPage.prState.${pr.state}`)}</span>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </>
  );
};

/**
 * The properties panel (task.md, "Properties panel"): what describes the task and doesn't change turn
 * to turn. Values carry no icons, so they all start at one x; the status dot and the driver's avatar
 * are the only markers. Spend (F-084) and the Changes group (F-027) come later.
 */
const Properties = ({ task, tokens, reasoningTokens, context, now, onTakeOver, takingOver, ticket, effort, noKey, projectName, checks }: {
  readonly task: Task;
  /** The newest turn's checks, for the Code group's `Checks` row (task-checks.md); `null` when none ran. */
  readonly checks: { readonly failing: number; readonly passed: number; readonly running: boolean } | null;
  /** F-137: the Effort row, built by the view (it holds the change's mutation). */
  readonly effort: ReactNode;
  /** F-135: queued with no key for its model. */
  readonly noKey: boolean;
  readonly projectName: string;
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
  const boxSize = task.box?.size ?? null;
  return (
    <div data-testid="task-properties">
      <PropGroup title={t("taskPage.properties")}>
        <PropRow label={t("taskPage.status")}>
          <Status tone={stateTone(task.state)} className="min-w-0">
            {/* A sub-state makes it long (`In review · waiting for a reviewer`): it wraps rather than cut a word. */}
            <span className="min-w-0 break-words" data-testid="task-status">{noKey ? t("noKey.queued") : statusWithSubState(task)}</span>
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
        {task.kind === "code" ? null : (
          <PropRow label={t("draft.kind")}><span data-testid="task-kind">{task.kind === "refine" ? t("draft.kindRefine") : t("draft.kindReview")}</span></PropRow>
        )}
        <PropRow label={t("taskAnswers.usage.profile")}>
          {task.agent === null ? <span className="text-faint">{t("taskAnswers.usage.none")}</span> : <span className="truncate" data-testid="task-profile">{task.agent.name}</span>}
          {task.agent?.builtInKind === null || task.agent?.builtInKind === undefined ? null : <Chip className="h-5 shrink-0 px-1.5 text-xs">{t("draft.builtIn")}</Chip>}
        </PropRow>
        {task.plan === null ? null : <PropRow label={t("taskAnswers.usage.plan")}><span className="truncate" data-testid="task-plan-row">{planRowText(task.plan)}</span></PropRow>}
        {task.agent === null ? null : (
          <>
            <PropRow label={t("taskPage.agent")}><span className="truncate">{task.agent.agentName}</span></PropRow>
            {task.agent.model === null ? null : (
              <PropRow label={t("taskPage.model")}>
                <span className="truncate">{task.agent.model.name}</span>
                {task.session?.providerName === undefined || task.session.providerName === null ? null : (
                  <span className="shrink-0 truncate" data-testid="task-key">
                    <span className="text-muted">{t("noKey.keyPrefix")}</span> <span className="font-mono text-ui">{task.session.providerName}</span>
                  </span>
                )}
              </PropRow>
            )}
            {noKey ? <KeyRow providerName={null} projectName={projectName} /> : null}
          </>
        )}
        {effort}
        <PropRow label={t("taskPage.runner")}>
          {/* Once the box is released the task has no runner (task-reopen.md, "Properties"). */}
          {task.runner === null || task.box?.state === "released" ? <span className="text-faint">{t("taskPage.noRunner")}</span> : <Mono>{task.runner.name}</Mono>}
        </PropRow>
        {task.runner === null || task.box?.state === "released" ? null : (
          <div className="pb-1.5 pl-[104px]"><RunnerKind runner={task.runner} /></div>
        )}
        {readOnlyKind(task.kind) ? (
          <PropRow label={t("draft.pushes")}><span className="truncate text-muted" data-testid="task-pushes">{task.state === "done" ? t("draft.pushesNoneDone") : t("draft.pushesNone")}</span></PropRow>
        ) : null}
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
        {task.sessions.length === 0 ? null : (
          <PropRow label={t("taskPage.session.label")}>
            <span className="truncate" data-testid="task-sessions">{sessionText(task.sessions)}</span>
          </PropRow>
        )}
        {boxSize === null ? null : <PropRow label={t("waitLine.panelBoxSize")}><Mono><span data-testid="task-box-size">{boxSizeText(boxSize)}</span></Mono></PropRow>}
        <PropRow label={t("taskPage.spend")}>
          <Mono><span data-reached={task.spend.reached}><SpendValue spend={task.spend} /></span></Mono>
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
      <TaskAttachmentsGroup taskId={task.id} pr={task.repos.flatMap((repo) => (repo.pr === null ? [] : [{ number: repo.pr.number, url: repo.pr.url }]))[0] ?? null} />
      <TaskMemory taskId={task.id} />
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
              {repo.pr === null ? null : <CodeHeadRows headSha={repo.headSha} ci={repo.ci} />}
              <PropRow label={t("taskPage.pr")}>
                {repo.pr === null || href === null ? <span className="text-faint">{t("taskPage.noPr")}</span> : (
                  <>
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-ui text-teal hover:underline" data-testid="pr-link">
                      #{repo.pr.number}
                    </a>
                    <span className="text-faint">·</span>
                    <span className={cn("text-ui", repo.pr.state === "merged" ? "text-green" : repo.pr.state === "closed" ? "text-faint" : "text-muted")} data-pr-state={repo.pr.state}>
                      {prIsDraft(repo) ? t("taskPage.prState.draft") : t(`taskPage.prState.${repo.pr.state}`)}
                    </span>
                  </>
                )}
              </PropRow>
            </div>
          );
        })}
        {checks === null ? null : (
          <PropRow label={t("checks.property.label")}>
            <span className="truncate text-[12.5px]" data-testid="task-checks-row">
              {checks.running ? (
                <span className="text-muted">{t("checks.property.running")}</span>
              ) : checks.failing > 0 ? (
                <>
                  <span className="text-red">{t("checks.summary.failed", { n: checks.failing })}</span>
                  {checks.passed > 0 ? <span className="text-muted">{t("checks.property.andPassed", { n: checks.passed })}</span> : null}
                </>
              ) : (
                <span className="text-green">{t("checks.property.allPassed", { n: checks.passed })}</span>
              )}
            </span>
          </PropRow>
        )}
      </PropGroup>
    </div>
  );
};

/** The task page's side pane (task-preview.md): the preview, or the properties. */
type SidePaneChoice = "preview" | "properties";

/** The words "Ask the agent to start the app" puts into the composer, unsent (task-preview.md, "Nothing to preview"). */
const putInComposer = (text: string): void => {
  const field = document.querySelector<HTMLTextAreaElement>("[data-part='composer'] textarea");
  if (field === null) return;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
};

/** Below 1024px the chat and the preview never share the screen (task-preview.md, "Phone"). */
const useNarrow = (): boolean => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const list = window.matchMedia("(max-width: 1023.98px)");
    const read = () => { setNarrow(list.matches); };
    read();
    list.addEventListener("change", read);
    return () => { list.removeEventListener("change", read); };
  }, []);
  return narrow;
};

/**
 * The task page (task.md; ADR 0036, F-023, F-025): the header, the live thread with its composer, and
 * the properties panel. Stop is optimistic and confirmed by the stream's change notice. Milestone 8
 * (F-141): the top bar's `Preview | Properties` chooses the side pane, kept in the address
 * (`?pane=preview&preview={key}&path=/history`, `&view=full` expanded, and ticket 26's `&mode=native`
 * or `stream` for the app in the member's own browser or the box's), so a link reopens it.
 */
export const TaskView = ({ taskId }: { readonly taskId: TaskId }) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const task = useQuery(trpc.tasks.get.queryOptions({ taskId }));
  const me = useQuery(trpc.me.get.queryOptions());
  const members = useQuery(trpc.organization.members.queryOptions());
  const project = useQuery(trpc.projects.get.queryOptions(task.data === undefined ? skipToken : { projectId: task.data.projectId }));
  // F-040: an outside task waiting for approval shows its block, from the project's Needs approval.
  const outsideApprovals = useQuery(trpc.tasks.needsApproval.queryOptions(task.data?.state === "awaiting_approval" ? { projectId: task.data.projectId } : skipToken));
  const waitingTask = outsideApprovals.data?.tasks.find((one) => one.taskId === taskId);
  const log = useTaskLog(taskId);
  const view = useMemo(() => deriveTaskState(log.state.events), [log.state.events]);
  const [stopping, setStopping] = useState(false);
  const now = useNow();
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const refine = task.data?.kind === "refine";
  // Ticket 34: a refine task's draft, for its tab; a refine task opens on it while a draft exists.
  const draft = useQuery(trpc.drafts.get.queryOptions(refine ? { taskId, version: null } : skipToken));
  const hasDraft = draft.data?.draft !== null && draft.data?.draft !== undefined;
  const tab: TaskTab =
    tabParam === "changes" || tabParam === "checks" || tabParam === "events"
      ? tabParam
      : tabParam === "draft" || (tabParam === null && refine && hasDraft)
        ? "draft"
        : "activity";
  const seqParam = Number.parseInt(params.get("seq") ?? "", 10);
  const selectTab = useCallback((next: TaskTab) => {
    const query = new URLSearchParams(params.toString());
    if (next === "activity" && !refine) query.delete("tab");
    else query.set("tab", next);
    const search = query.toString();
    router.replace(search === "" ? `/tasks/${taskId}` : `/tasks/${taskId}?${search}`, { scroll: false });
  }, [params, router, taskId, refine]);
  const [localOpened, setLocalOpened] = useState(false);
  const local = useQuery(trpc.tasks.local.queryOptions(localOpened ? { taskId } : skipToken));
  const checksMarker = useQuery({ ...trpc.tasks.checks.queryOptions({ taskId }), refetchInterval: 15_000 });
  // The Event log tab's marker: the log's row count (task-event-log.md), its `All`.
  const eventRows = useQuery({ ...trpc.tasks.eventLogCount.queryOptions({ taskId }), refetchInterval: 15_000 });
  // Milestone 6 (ticket 35): a code task's review rounds, and whether its project's AI review is on.
  const codeTask = task.data?.kind === "code";
  const rounds = useQuery({ ...trpc.tasks.rounds.queryOptions(codeTask ? { taskId } : skipToken), refetchInterval: 15_000 });
  // Milestone 8 (F-141): the task's previews, for the side pane's default and its toggle.
  const previewList = useQuery(trpc.previews.list.queryOptions(codeTask ? { taskId } : skipToken));
  const paneParam = params.get("pane");
  const hasPreviews = (previewList.data?.previews.length ?? 0) > 0;
  const side: SidePaneChoice = !codeTask ? "properties" : paneParam === "preview" || paneParam === "properties" ? paneParam : hasPreviews ? "preview" : "properties";
  const expanded = side === "preview" && params.get("view") === "full";
  const narrowScreen = useNarrow();
  const shell = useOptionalShellState();
  const setQuery = useCallback((change: Readonly<Record<string, string | null>>) => {
    const query = new URLSearchParams(params.toString());
    for (const [name, value] of Object.entries(change)) {
      if (value === null) query.delete(name);
      else query.set(name, value);
    }
    const search = query.toString();
    router.replace(search === "" ? `/tasks/${taskId}` : `/tasks/${taskId}?${search}`, { scroll: false });
  }, [params, router, taskId]);
  const setExpanded = useCallback((next: boolean) => { setQuery({ pane: "preview", view: next ? "full" : null }); }, [setQuery]);
  // Expanded, the context panel collapses for now, never saved over the member's choice.
  const holdPanel = shell?.hold;
  useEffect(() => {
    if (holdPanel === undefined) return;
    holdPanel(expanded);
    return () => { holdPanel(false); };
  }, [expanded, holdPanel]);
  // Escape, with the focus outside the app and any field, goes back to the chat.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [role='dialog'], [role='menu'], [role='listbox']") !== null) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, [expanded, setExpanded]);
  const reviewSettings = useQuery(trpc.projects.reviewSettings.queryOptions(codeTask && task.data !== undefined ? { projectId: task.data.projectId } : skipToken));

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
  const keepWorking = useMutation(trpc.tasks.keepWorking.mutationOptions({ onSettled: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: getKey }), queryClient.invalidateQueries({ queryKey: trpc.tasks.rounds.queryKey({ taskId }) })]); } }));
  const retrySync = useMutation(trpc.tasks.retrySync.mutationOptions(settle));
  const dismiss = useMutation(trpc.tasks.dismissNeedsYou.mutationOptions(settle));
  // F-066: the ticket-closed card's own calls, so their refusals show in the card.
  const closedStop = useMutation(trpc.tasks.stop.mutationOptions(settle));
  const closedKeep = useMutation(trpc.tasks.keepWorking.mutationOptions(settle));
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
  // Ticket 43: the approvals another member answered first, for this member's "Someone answered this first."
  const [lostRaces, setLostRaces] = useState<ReadonlySet<string>>(() => new Set());
  const lostRace = useCallback((approvalId: string) => { setLostRaces((now) => new Set([...now, approvalId])); }, []);
  const approvalLostRace = useCallback((approvalId: string) => lostRaces.has(approvalId), [lostRaces]);
  const approvalCard = useCallback(
    (approvalId: string, asker?: string): ReactNode => {
      const approval = approvals?.find((one) => one.approvalId === approvalId);
      if (approval === undefined || (approval.state !== "open" && !approval.answerableAnyway)) return null;
      const othersOpen = (approvals ?? []).filter((one) => one.state === "open" && one.approvalId !== approvalId).length;
      // F-138: a subagent's call that asks names the subagent.
      return <ApprovalCard key={approvalId} taskId={taskId} approval={approval} agent={agentName} project={projectName} othersOpen={othersOpen} onLostRace={lostRace} {...(asker === undefined ? {} : { asker })} />;
    },
    [approvals, taskId, agentName, projectName, lostRace],
  );
  const receiptOf = useCallback(
    (approvalId: string): string | null => {
      const approval = approvals?.find((one) => one.approvalId === approvalId);
      return approval === undefined ? null : approvalReceipt(approval);
    },
    [approvals],
  );
  const logEvents = log.state.events;
  const questionCard = useCallback(
    (questionId: string): ReactNode => {
      const question = questions?.find((one) => one.questionId === questionId);
      return question === undefined ? null : (
        <QuestionCard
          taskId={taskId}
          question={question}
          agent={agentName}
          isDriver={isDriver}
          driver={driverName}
          onTakeOver={takeOverNow}
          takingOver={takeOver.isPending}
          repeats={questionRepeatsMessage(logEvents, questionId, question.message)}
        />
      );
    },
    [questions, taskId, agentName, isDriver, driverName, takeOverNow, takeOver.isPending, logEvents],
  );

  // F-081 (ticket 13): the page, its viewer's capabilities and its open item, for the palette and the keys.
  const scopeData = task.data;
  const previewKeys = useRef({ toggle: () => undefined, expand: () => undefined });
  previewKeys.current = {
    toggle: () => { setQuery({ pane: side === "preview" ? "properties" : "preview", view: null }); },
    expand: () => { setExpanded(!expanded); },
  };
  const actionScope = useMemo((): TaskScope | null => {
    if (scopeData === undefined) return null;
    const approval = scopeData.approvals.find((one) => one.state === "open");
    const question = isDriver ? scopeData.questions[0] : undefined;
    const inItem = (id: string, selector: string, act: (node: HTMLElement) => void) => {
      const node = document.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"] ${selector}`);
      if (node !== null) act(node);
    };
    const item: ItemScope | null =
      approval !== undefined
        ? { kind: "approval", approvalId: approvalIdSchema.parse(approval.approvalId), taskId, key: scopeData.key, deny: () => { inItem(approval.approvalId, "[data-action='deny']", (node) => { node.click(); }); } }
        : question !== undefined
          ? { kind: "question", questionId: questionIdSchema.parse(question.questionId), taskId, key: scopeData.key, reply: () => { inItem(question.questionId, "input, textarea", (node) => { node.focus(); }); } }
          : null;
    return {
      taskId,
      projectId: scopeData.projectId,
      key: scopeData.key,
      title: scopeData.title,
      canTakeOver: scopeData.capabilities.takeOver,
      canStop: scopeData.capabilities.stop && scopeData.state !== "stopped",
      canReopen: scopeData.capabilities.reopen,
      canSend: scopeData.capabilities.send,
      item,
      focusComposer: () => { document.querySelector<HTMLElement>("[data-part='composer'] textarea")?.focus(); },
      // Milestone 8 (F-141): `p` and `f`, on a code task's page. The scope is set again only when its
      // facts change, so the keys call through a ref to the page's state now.
      ...(codeTask ? { preview: { toggle: () => { previewKeys.current.toggle(); }, expand: () => { previewKeys.current.expand(); } } } : {}),
    };
  }, [scopeData, isDriver, taskId, codeTask]);
  useProvideTaskScope(actionScope);

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
  const prs = data.repos.flatMap((repo): BarPr[] => {
    const href = repo.pr === null ? null : safeHref(repo.pr.url);
    return repo.pr === null || href === null ? [] : [{ number: repo.pr.number, href, state: repo.pr.state, repo: repo.fullName, draft: prIsDraft(repo) }];
  });
  const running = view.turnRunning || data.state === "running" || data.state === "preparing";
  // F-137: the level from the newest `effort.changed` on the stream, else `tasks.get`'s.
  const effort: TaskEffort = { level: view.effort ?? data.effort.level, levels: data.effort.levels.map((one) => one.level), runningTurn: view.runningEffort };
  const stateText = stopping && !stopped ? t("taskPage.stopping") : taskStateLine(data.state, data.reason, data.limit);
  // A limit or a crash ended the session: the line says when it stopped (task-limits.md, "Status").
  const stoppedAt = data.state === "needs_you" && (data.limit !== null || data.reason === "crashed") ? (data.sessions.at(-1)?.endedAt ?? null) : null;
  const organizationAdmin = me.data?.organization?.role === "admin";
  // F-135: queued because no key on the project's list serves the profile's model.
  const noKey: NoKey | null =
    data.waiting?.kind === "no-runner" && data.waiting.reason.code === "no-provider-for-model"
      ? {
          model: data.agent?.model?.name ?? data.waiting.reason.modelName,
          mono: data.agent?.model === null || data.agent === null,
          projectName: project.data?.name ?? "",
          provider: data.waiting.reason.provider ?? null,
        }
      : null;
  // Who can fix a missing key, by name and role only (no-key-for-model.md, open point 3).
  const admins = (members.data ?? []).filter((member) => member.role === "admin").map((member) => member.name);
  // A task that ran before and lost its key holds the member's message (section 3): the marker under it.
  const heldNoKey = noKey !== null && log.state.events.some(({ event }) => event.kind === "turn.started");
  // A plan waiting on its driver says so in the status (`Needs you · plan`): the ended turn isn't said again (task-plan.md).
  const activity = idleHeader(data.box, now) ?? (data.state === "needs_you" && data.reason === "plan" ? "" : headerActivity(view.activity));
  // F-067: a queued task an admin or its member cancelled names who did.
  const cancelled = data.state === "stopped" ? log.state.events.findLast(({ event }) => event.kind === "task.cancelled")?.event : undefined;
  const cancelledBy = cancelled?.kind === "task.cancelled" ? ((members.data ?? []).find((member) => member.memberId === cancelled.memberId)?.name ?? null) : undefined;
  const mode = composerMode(composerInputOf(data));
  // What needs you (2026-11-21): cards in the chat, never a block above the tabs.
  const needs = needsOf({
    state: data.state,
    group: data.group,
    reason: data.reason,
    kind: data.kind,
    limit: data.limit,
    needsYou: data.needsYou,
    openApprovals: data.approvals.filter((one) => one.state === "open" || one.answerableAnyway).length,
    openQuestions: data.questions.length,
    planWaiting: data.plan !== null && data.plan.approved === null && data.plan.itemId !== null,
  });
  const how: ReplyHow = mode.kind === "send" ? "send" : mode.kind === "reopen" ? "reopen" : data.capabilities.takeOver ? "watch" : "none";
  const conflict = data.needsYou.find((item) => item.reason === "restore_conflict");
  const sessionGoing = data.session !== null && ["starting", "running", "waiting", "idle"].includes(data.session.state);
  const changedFiles = data.repos.length;
  const localLoad: LocalLoad = local.data !== undefined
    ? { kind: "ready", local: { checkoutLine: local.data.checkoutCommand, loginLine: local.data.loginCommand, hasCliSession: local.data.hasCliSession, repos: local.data.repos.map((repo) => ({ fullName: repo.fullName, branch: repo.branch, mergedPr: repo.pr?.state === "merged" ? repo.pr.number : null })) } }
    : local.error !== null
      ? { kind: "error", message: errorText(local.error) ?? t("errors.unknown") }
      : { kind: "loading" };
  const firstBoard = boards.data?.boards[0];
  const isRefine = data.kind === "refine";
  // Ticket 34: the board's ready status by name, from the board's statuses.
  const draftBoard = boards.data?.boards.find((board) => board.id === draft.data?.board?.boardId);
  const readyStatusName =
    draftBoard?.statusGroups?.flatMap((group) => group.statuses).find((status) => status.id === draft.data?.board?.readyStatusId)?.name ?? null;
  const moveWrite = data.sync.findLast((write) => write.kind === "move");
  const ticketGroups = (
    <TicketProperties
      task={{ ticket: data.ticket, sync: isRefine ? [] : data.sync, canRetry: data.capabilities.retrySync }}
      now={now}
      retry={{ run: () => { retrySync.mutate({ taskId }); }, pending: retrySync.isPending }}
      createTicket={
        data.source === "prompt" && firstBoard !== undefined && !isRefine
          ? { run: () => { createTicket.mutate({ taskId, boardId: firstBoard.id }); }, pending: createTicket.isPending, error: errorText(createTicket.error) }
          : null
      }
    />
  );
  const aiReview = reviewSettings.data?.aiReview ?? true;
  const roundList = rounds.data?.rounds ?? [];
  const heldNow = roundList.some((round) => round.state === "held");
  const inLoop = data.kind === "code" && data.subState !== null && (data.state === "in_review" || data.state === "needs_you");
  const cap = data.state === "needs_you" && data.reason === "round_cap" ? (capOf(roundList) ?? "turns") : null;
  const lastCi = roundList.findLast((round) => round.cause.kind === "ci");
  const failingCheck = lastCi?.cause.kind === "ci" ? (lastCi.cause.failing[0]?.name ?? null) : null;
  const lastFindings = roundList.findLast((round) => round.cause.kind === "findings");
  const blockingSent = lastFindings?.cause.kind === "findings" ? lastFindings.cause.findings.filter((finding) => finding.severity === "blocking").length : 0;
  const roundsTail =
    rounds.data === undefined ? null : (
      <RoundsInThread
        taskId={taskId}
        rounds={roundList}
        limits={rounds.data.limits}
        cap={cap}
        capInput={{ agent: agentName, failing: failingCheck, blocking: blockingSent }}
        isDriver={isDriver}
        driver={driverName}
        keep={{ run: () => { keepWorking.mutate({ taskId }); }, pending: keepWorking.isPending, error: errorText(keepWorking.error) }}
        onTakeOver={takeOverNow}
      />
    );
  const roundsGroup =
    data.kind === "code" && (roundList.length > 0 || inLoop) ? (
      <RoundsGroup
        counts={data.roundCounts}
        aiReview={aiReview}
        since={data.roundCounts.lastPersonActionAt === null ? null : formatClock(data.roundCounts.lastPersonActionAt)}
        held={heldNow}
      />
    ) : null;
  const draftGroups = isRefine ? (
    <DraftProperties taskId={taskId} meId={me.data?.memberId ?? null} readyStatusName={readyStatusName} moveState={moveWrite === undefined ? null : moveWrite.state === "done" ? "done" : moveWrite.state === "failed" ? "failed" : "pending"} now={now} />
  ) : null;
  // A member who isn't the driver sees who is, and how to take over, where the composer would be.
  const notDriver =
    data.capabilities.send || !data.capabilities.takeOver || finished ? undefined : (
      <WatcherBar driver={data.driver?.name ?? null} onTakeOver={takeOverNow} takingOver={takeOver.isPending} />
    );

  const previewing = side === "preview";
  const eventsMarker = eventRows.data === undefined || eventRows.data.rows === 0 ? null : <span className="font-mono text-xs text-faint" data-testid="event-log-count">{eventRows.data.rows}</span>;
  const sideToggle = codeTask ? (
    <ToggleGroup
      type="single"
      value={side}
      aria-label={t("task.preview.side")}
      onValueChange={(value) => { if (value === "preview" || value === "properties") setQuery({ pane: value, view: null }); }}
      className="h-7 max-lg:hidden"
      data-testid="side-pane-toggle"
    >
      <ToggleGroupItem value="preview" aria-label={t("task.preview.sidePreview")} className="flex items-center gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">
        <AppWindowIcon aria-hidden /> <span className="max-md:hidden">{t("task.preview.sidePreview")}</span>
      </ToggleGroupItem>
      <ToggleGroupItem value="properties" aria-label={t("task.preview.sideProperties")} className="flex items-center gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px] [&_svg]:stroke-[1.75]">
        <PanelRightIcon aria-hidden /> <span className="max-md:hidden">{t("task.preview.sideProperties")}</span>
      </ToggleGroupItem>
    </ToggleGroup>
  ) : null;
  const stopButton = data.capabilities.stop && !stopped ? (
    <Button data-action="stop" onClick={() => { stop.mutate({ taskId }); }} disabled={stopping || stop.isPending} aria-label={stopping ? t("taskPage.stopping") : t("taskPage.stop")}>
      <SquareIcon aria-hidden /> <span className="max-sm:hidden">{stopping ? t("taskPage.stopping") : t("taskPage.stop")}</span>
    </Button>
  ) : null;
  const previewPane = previewing ? (
    <PreviewPane
      task={{
        id: taskId,
        key: data.key,
        projectId: data.projectId,
        projectName,
        organizationName: me.data?.organization?.name ?? "",
        state: data.state,
        runnerName: data.runner?.name ?? null,
        projectAdmin: organizationAdmin,
      }}
      events={log.state.events}
      previewKey={params.get("preview")}
      path={params.get("path")}
      onAddress={(next) => { setQuery({ pane: "preview", preview: next.preview, path: next.path }); }}
      expanded={expanded}
      onExpand={setExpanded}
      onAskAgent={
        data.capabilities.send
          ? () => {
              if (narrowScreen) setQuery({ pane: null });
              putInComposer(t("task.preview.none.askText"));
            }
          : null
      }
      steer={
        <PreviewSteerBar
          taskId={taskId}
          agent={agentName}
          activity={activity}
          working={running}
          status={`${data.key} · ${stateText}`}
          canSend={data.capabilities.send}
          takeOver={data.capabilities.takeOver && !finished ? { run: takeOverNow, pending: takeOver.isPending } : null}
        />
      }
      members={members.data ?? []}
      now={now}
      phone={narrowScreen}
      mode={params.get("mode")}
      onMode={(next) => { setQuery({ pane: "preview", mode: next }); }}
      memberId={me.data?.memberId ?? null}
      instanceAdmin={me.data?.instanceAdmin ?? false}
    />
  ) : null;

  return (
    <PageFrame
      padded={false}
      crumbs={[
        { label: project.data?.name ?? "", href: `/projects/${data.projectId}` },
        { label: t("shell.tasks"), href: `/projects/${data.projectId}` },
        { label: data.key },
      ]}
      // A phone's top bar: the title over `CALC-192 · ● Running` (app-shell.md, "Phone").
      phoneTitle={{ title: data.title, line: <>{data.key} · <Status tone={stateTone(data.state)} className="min-w-0 gap-1.5"><span className="truncate">{stateText}</span></Status></> }}
      actions={
        expanded ? (
          <>
            <span className="text-[13px] text-faint max-lg:hidden">{t("task.preview.press")}</span>
            <Kbd className="rounded-sm border border-line-2 px-1.5 py-0.5 max-lg:hidden">esc</Kbd>
            <Button onClick={() => { setExpanded(false); }} data-action="collapse-preview">
              <Minimize2Icon aria-hidden /> <span className="max-sm:hidden">{t("task.preview.collapse")}</span>
            </Button>
            {stopButton}
          </>
        ) : (
          <>
            {sideToggle}
            <CopyLink />
            <TakeItLocal pushed={data.repos.some((repo) => repo.headSha !== null)} load={localLoad} onOpen={() => { setLocalOpened(true); }} />
            {data.kind === "code" && data.repos.some((repo) => repo.pr?.state === "open") ? (
              <Link href={`/tasks/${taskId}/review`} className={buttonVariants()} aria-label={t("review.button")} data-action="open-review">
                <ScanSearchIcon aria-hidden /> <span className="max-sm:hidden">{t("review.button")}</span>
              </Link>
            ) : null}
            <PrButtons prs={prs} />
            {stopButton}
          </>
        )
      }
      {...(previewPane === null
        ? {}
        : {
            pane: {
              node: previewPane,
              expanded,
              narrow: paneParam === "preview" ? ("pane" as const) : ("page" as const),
              switcher: (
                <ToggleGroup
                  type="single"
                  value={paneParam === "preview" ? "preview" : "chat"}
                  aria-label={t("task.preview.narrowSwitch")}
                  onValueChange={(value) => { if (value === "preview" || value === "chat") setQuery({ pane: value === "preview" ? "preview" : null }); }}
                  className="mx-3 my-2 flex h-11"
                >
                  <ToggleGroupItem value="chat" className="flex flex-1 items-center justify-center gap-1.5 [&_svg]:size-[15px] [&_svg]:stroke-[1.75]"><MessageSquareIcon aria-hidden /> {t("task.preview.chat")}</ToggleGroupItem>
                  <ToggleGroupItem value="preview" className="flex flex-1 items-center justify-center gap-1.5 [&_svg]:size-[15px] [&_svg]:stroke-[1.75]"><AppWindowIcon aria-hidden /> {t("task.preview.sidePreview")}</ToggleGroupItem>
                </ToggleGroup>
              ),
            },
          })}
      properties={
        <Properties
          task={data}
          checks={checksPropertyOf(checksMarker.data)}
          tokens={view.tokens}
          reasoningTokens={view.reasoningTokens}
          context={view.context}
          now={now}
          takingOver={takeOver.isPending}
          onTakeOver={() => { takeOver.mutate({ taskId }); }}
          ticket={<>{roundsGroup}{ticketGroups}{draftGroups}</>}
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
          noKey={noKey !== null}
          projectName={project.data?.name ?? ""}
        />
      }
    >
      <div className={cn("flex min-h-full flex-col", previewing ? "px-4 pb-4 pt-6 sm:px-7 sm:pt-[22px] lg:h-full" : "px-4 pb-5 pt-6 sm:px-10 sm:pt-[26px] xl:h-full")}>
        <div className="shrink-0">
          <div className="flex items-center gap-2.5 font-mono text-sm leading-[17px] text-faint">
            <span>{data.key} · {data.source === "prompt" ? t("taskPage.fromPrompt") : data.ticket === null ? t("taskPage.fromTicket") : t("taskPage.fromTracker", { tracker: trackerName(data.ticket.tracker) })}</span>
            {waitingTask?.startedBy.kind === "outside" ? <span className="font-sans text-ui">· <StartedInLinear task={waitingTask} /></span> : null}
            {data.kind === "code" ? null : <Chip className="font-mono text-muted">{data.kind === "refine" ? t("draft.chipRefine") : t("draft.chipReview")}</Chip>}
          </div>
          <h1 className={cn("page-title mb-1.5 mt-1 break-words", previewing && "lg:text-[24px]")}>{data.title}</h1>
          <p className="flex flex-wrap items-center gap-x-2 text-body" data-testid="task-doing" data-state={data.state}>
            <Status tone={stateTone(data.state)}><span className="font-medium text-text">{noKey === null ? stateText : t("noKey.queued")}</span></Status>
            {activity === "" ? null : <><Sep /><span className="text-muted">{activity}</span></>}
            {readOnlyKind(data.kind) ? <><Sep /><span className="text-muted" data-testid="task-read-only">{data.state === "done" ? t("draft.readOnlyDone") : t("draft.readOnly")}</span></> : null}
            <Sep />
            <span className="text-muted">
              {stoppedAt === null ? t("taskPage.started", { age: formatElapsed(data.createdAt, now) }) : t("taskPage.stoppedAgo", { age: formatElapsed(stoppedAt, now) })}
              {data.runner === null ? null : <> {t("taskPage.on")} <span className="font-mono text-ui text-faint">{data.runner.name}</span></>}
            </span>
            {log.state.connection === "reconnecting" ? <><Sep /><span className="text-muted">{t("taskPage.reconnecting")}</span></> : null}
          </p>
          {inLoop ? <StageLine subState={data.subState} aiReview={aiReview} counts={data.roundCounts} needsYou={cap !== null && isDriver} held={heldNow} /> : null}
          <div className="max-sm:hidden">
            <TaskPrs repos={data.repos} />
          </div>
          <TaskAppSupportLine taskId={taskId} />
          {data.waiting?.kind === "no-runner" && data.waiting.reason.code === "needs-services-runner" ? (
            <p className="mt-1.5 text-ui text-muted" data-testid="task-dispatch-note">{servicesWaitText(data.waiting.reason.online)}</p>
          ) : null}
          {data.waiting?.kind === "no-runner" && data.waiting.reason.code === "provider-not-allowed" ? (
            <p className="mt-1.5 text-ui text-muted" data-testid="task-dispatch-note">{t("noKey.providerNotAllowed", { project: project.data?.name ?? "" })}</p>
          ) : null}
          {data.waiting?.kind === "no-runner" && data.waiting.reason.code === "installation-not-linked" ? (
            <p className="mt-1.5 text-ui text-muted" data-testid="task-dispatch-note">{t("githubOrgs.installationWait", { repo: data.waiting.reason.repo })}</p>
          ) : null}
          <TaskWaiting
            projectId={data.projectId}
            project={project.data?.name ?? ""}
            waiting={data.waiting?.kind === "no-runner" && wordedElsewhere.has(data.waiting.reason.code) ? null : data.waiting}
            queue={data.queue}
            boxWaiting={data.box?.waiting ?? null}
            runnerId={data.runner?.kind === "personal" ? data.runner.id : null}
            cancelledBy={cancelledBy}
            now={now}
          />
          {noKey === null ? null : (
            <div className="mt-2.5 border-l-2 border-line-2 pl-3" data-testid="task-no-key">
              <p className="text-body text-text"><NoKeySentence noKey={noKey} /></p>
              <p className="text-ui text-muted">
                <WhoPicks projectId={data.projectId} organizationAdmin={organizationAdmin} suffix={t("noKey.startsItself")} provider={noKey.provider} />
              </p>
              {organizationAdmin || admins.length === 0 ? null : <p className="mt-0.5 text-sm text-faint">{adminNames(admins)}</p>}
            </div>
          )}
          {data.waiting?.kind === "no-runner" && (data.waiting.reason.code === "budget-reached" || data.waiting.reason.code === "model-unpriced") ? (
            <p className="mt-1.5 text-ui text-muted" data-testid="task-budget-wait">
              {data.waiting.reason.code === "model-unpriced"
                ? t("taskPage.waitUnpriced")
                : data.waiting.reason.scope === "project"
                  ? t("taskPage.waitBudgetProject", { project: projectName, month: monthWord(now) })
                  : t("taskPage.waitBudgetOrganization", { month: monthWord(now) })}
            </p>
          ) : null}
          {/* Under 640px the ticket, its sync and the PRs are sections of their own (m2's `phone-task`). */}
          <div className="max-sm:hidden">
            {data.ticket === null ? null : <TicketLine ticket={data.ticket} />}
            {data.source === "ticket" && tab !== "draft" ? <AgentGot files={data.contextFiles} /> : null}
          </div>
          <PhoneTaskSections
            task={{ ticket: data.ticket, sync: data.sync, repos: data.repos, contextFiles: data.contextFiles, kind: data.kind, canRetry: data.capabilities.retrySync }}
            retry={{ run: () => { retrySync.mutate({ taskId }); }, pending: retrySync.isPending }}
          />
          {stop.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(stop.error)}</p>}
          <UnderlineTabs
            className="mt-4"
            label={t("taskAnswers.tabs.activity")}
            idPrefix="task-tab"
            selected={tab}
            onSelect={selectTab}
            tabs={
              isRefine
                ? [
                    { id: "activity", label: t("taskAnswers.tabs.activity") },
                    // A refine task changes nothing: no Changes or Checks tab (refine-draft.md).
                    { id: "draft", label: t("draft.tab"), extra: draft.data?.draft === null || draft.data?.draft === undefined ? null : <span className="font-mono text-faint">{t("draft.versionShort", { n: draft.data.draft.version })}</span> },
                    { id: "events", label: t("taskAnswers.tabs.events"), extra: eventsMarker },
                  ]
                : [
                    { id: "activity", label: t("taskAnswers.tabs.activity") },
                    { id: "changes", label: t("taskAnswers.tabs.changes"), extra: changedFiles === 0 ? null : <span className="text-faint">{changedFiles}</span> },
                    { id: "checks", label: t("taskAnswers.tabs.checks"), extra: <ChecksTabMarker marker={checksMarkerOf(checksMarker.data)} /> },
                    { id: "events", label: t("taskAnswers.tabs.events"), extra: eventsMarker },
                  ]
            }
          />
        </div>
        {log.error === null ? null : <p role="alert" className="mt-3 text-red">{log.error}</p>}
        {tab === "draft" && isRefine ? (
          <DraftView
            taskId={taskId}
            meId={me.data?.memberId ?? null}
            needsYou={data.state === "needs_you"}
            running={running}
            ticket={data.ticket === null ? null : { key: data.ticket.key, url: data.ticket.url }}
            boards={(boards.data?.boards ?? []).map((board) => ({ boardId: board.id, name: board.name }))}
            readyStatusName={readyStatusName}
            newRefineHref={`/tasks/new?project=${encodeURIComponent(data.projectId)}&kind=refine`}
            now={now}
          />
        ) : tab === "changes" ? (
          <div className="min-h-0 flex-1" id="task-tab-changes">
            <ChangesTab taskId={taskId} agent={agentName} driver={driverName} isDriver={isDriver} running={running} steersMidTurn={data.capabilities.steersMidTurn} sessionGoing={sessionGoing} onTakeOver={takeOverNow} onSeeActivity={() => { selectTab("activity"); }} />
          </div>
        ) : tab === "events" ? (
          <div className="flex min-h-0 flex-1 flex-col" id="task-tab-events">
            <EventLogTab taskId={taskId} names={names} executor={data.runner?.executor ?? null} seq={Number.isInteger(seqParam) && seqParam > 0 ? seqParam : null} agent={agentName} model={data.agent?.model?.name ?? null} />
          </div>
        ) : tab === "checks" ? (
          <div className="min-h-0 flex-1" id="task-tab-checks">
            <ChecksTab taskId={taskId} projectId={data.projectId} agent={agentName} driver={driverName} isDriver={isDriver} running={running} sessionGoing={sessionGoing} now={now} onTakeOver={takeOverNow} onSeeActivity={() => { selectTab("activity"); }} />
          </div>
        ) : (
        <TaskThread
          projectName={projectName}
          ticketKey={data.ticket?.key ?? null}
          taskId={taskId}
          log={log.state}
          memberId={me.data?.memberId ?? null}
          memberName={memberName}
          canSend={data.capabilities.send}
          canReopen={mode.kind === "reopen"}
          composerHint={mode.kind === "send" || mode.kind === "reopen" ? (isRefine ? t("draft.composerHint") : ((mode.kind === "send" ? replyHint(needs, agentName) : null) ?? mode.hint)) : null}
          {...(mode.kind === "merged"
            ? { instead: <MergedHint inboxHref={data.ticket === null ? null : `/projects/${data.projectId}/inbox?ticket=${encodeURIComponent(data.ticket.key)}`} /> }
            : mode.kind === "none" && data.capabilities.reopenBlocked === "spend_cap"
              ? { instead: <SpendCapComposer /> }
              : {})}
          canInterrupt={data.capabilities.interrupt}
          running={running}
          agent={{ name: data.agent?.agentName ?? t("task.agent"), model: data.agent?.model?.name ?? null }}
          approvalSummary={approvalSummary}
          approvalCard={approvalCard}
          approvalReceipt={receiptOf}
          approvalLostRace={approvalLostRace}
          questionCard={questionCard}
          tail={
            <>
              {heldNoKey ? <HeldNoKey noKey={noKey} /> : data.plan === null ? roundsTail : (
                <div className="ml-10">
                  <PlanBlock key={`${data.plan.turnId}:${String(data.plan.proposedAt)}`} taskId={taskId} plan={data.plan} agent={agentName} isDriver={isDriver} driver={driverName} onTakeOver={takeOverNow} takingOver={takeOver.isPending} />
                </div>
              )}
              <NeedsYouCards
                needs={needs}
                agent={agentName}
                how={how}
                limit={{
                  task: limitStateOf(data),
                  reopen: {
                    run: () => { reopen.mutate({ taskId, clientMessageId: clientMessageIdSchema.parse(crypto.randomUUID()) }); },
                    pending: reopen.isPending,
                    error: errorText(reopen.error),
                  },
                }}
                ticketClosed={{
                  stop: { run: () => { closedStop.mutate({ taskId }); }, pending: closedStop.isPending || closedStop.isSuccess, error: errorText(closedStop.error) },
                  keep: { run: () => { closedKeep.mutate({ taskId }); }, pending: closedKeep.isPending || closedKeep.isSuccess, error: errorText(closedKeep.error) },
                }}
                conflict={{
                  canAnswer: data.driver?.memberId === me.data?.memberId,
                  dismiss: { run: () => { if (conflict !== undefined) dismiss.mutate({ taskId, itemId: conflict.id }); }, pending: dismiss.isPending },
                }}
                awaiting={waitingTask}
              />
            </>
          }
          live={<NeedsYouLive needs={needs} agent={agentName} how={how} />}
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
