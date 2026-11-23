"use client";

import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindowIcon, MessageSquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { approvalIdSchema, clientMessageIdSchema, questionIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import { deriveTaskState } from "@ostra/task-view";

import { servicesWaitText } from "@/components/projects/environment-services-words";
import { useProvideTaskScope } from "@/components/shell/actions/use-scope";
import type { ItemScope, TaskScope } from "@/components/shell/actions/use-scope";
import { PageFrame } from "@/components/shell/page-frame";
import { useOptionalShellState } from "@/components/shell/shell-state";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Status } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";
import { TaskThread } from "@/task/task-thread";
import { composerWordsOf, showsInterrupt } from "@/task/thread/composer-words";
import { useTaskLog } from "@/task/use-task-log";

import { TaskAppSupportLine } from "./attachments/attachments-group";
import { TicketContextRows } from "./attachments/ticket-context-thread";
import { monthWord } from "./budget-reason";
import { PhoneTaskSections } from "./phone-task-sections";
import { TaskPrs } from "./task-prs";
import { HeldNoKey, NoKeySentence, WhoPicks } from "./no-key";
import { adminNames } from "./no-key-words";
import type { NoKey } from "./no-key";
import { AgentGot, MergedHint, TicketLine, TicketProperties, composerInputOf, composerMode, idleHeader, limitStateOf, SpendCapComposer, trackerName } from "./task-ticket";
import { headerActivity, stateTone, taskStateLine } from "./task-words";
import { ApprovalCard, PlanBlock, QuestionCard, WatcherBar, approvalReceipt } from "./task-answers";
import { NeedsYouCards, NeedsYouLive } from "./needs-you-cards";
import { needsOf, questionRepeatsMessage, replyHint } from "./needs-you-card-words";
import type { ReplyHow } from "./needs-you-card-words";
import { ChangesTab } from "./task-changes/changes-tab";
import { EventLogTab } from "./task-event-log/event-log-tab";
import { ChecksTab, checksMarkerOf, checksPropertyOf } from "./task-checks/checks-tab";
import { markerWithCi } from "./task-checks/check-words";
import { ChecksTabMarker } from "./task-checks/task-checks";
import { NextTurnMenu, TaskEffortRow } from "./task-effort";
import type { TaskEffort } from "./task-effort";
import { Properties } from "./task-properties";
import { TaskStatusLine } from "./task-status-line";
import { TaskTopBar } from "./task-top-bar";
import type { SidePaneChoice } from "./task-top-bar";
import { StartedInLinear } from "@/components/approvals/approval-block";

import { TaskWaiting } from "./task-waiting";
import { PreviewPane } from "./preview-pane";
import { PreviewSteerBar } from "./preview-steer-bar";
import type { LocalLoad } from "./take-it-local";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { Chip } from "@/components/ui/status";
import { DraftView } from "./draft/draft-view";
import { DraftProperties } from "./draft/draft-properties";
import { capOf, runningCiJobs } from "./review/review-words";
import { RoundsGroup, RoundsInThread, StageLine } from "./review/task-rounds";
import { AiReviewLine, FollowUpWaiting, ReviewOfLine } from "./review/follow-up";
import { followUpWaitWords } from "./review/follow-up-words";
import { formatClock } from "@/lib/format";
import { useRouter, useSearchParams } from "next/navigation";

// Milestone 10 (ticket 09): the properties panel lives in `task-properties.tsx`; its tests still import it from here.
export { Properties } from "./task-properties";

type TaskTab = "activity" | "changes" | "checks" | "events" | "draft";

/** No turns priced yet, and an agent with no MCP servers: one value each, so the thread's memos hold. */
const noTurns: readonly [] = [];
const noServers: readonly string[] = [];

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
  // Milestone 10 (F-151): what the compact thread reads of the task: each turn's figures, the repos'
  // checkout folders (for relative paths) and their CI on their heads (for the PR card).
  const usageTurns = task.data?.usage?.turns ?? noTurns;
  const repos = task.data?.repos;
  const checkoutDirs = useMemo(() => (repos ?? []).map((repo) => repo.checkoutDir), [repos]);
  const ciOf = useCallback((repoId: string) => repos?.find((repo) => repo.repoId === repoId)?.ci ?? null, [repos]);
  const [stopping, setStopping] = useState(false);
  const now = useNow();
  const router = useRouter();
  const params = useSearchParams();
  const tabParam = params.get("tab");
  const refine = task.data?.kind === "refine";
  // Ticket 34: a refine task's draft, for its tab; a refine task opens on it while a draft exists.
  const draft = useQuery(trpc.drafts.get.queryOptions(refine ? { taskId, version: null } : skipToken));
  const ticketContext = useQuery(trpc.tasks.ticketContext.queryOptions(task.data?.source === "ticket" ? { taskId } : skipToken));
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
  // Milestone 10 (ticket 14): what the thread's results read: the repos' heads and PRs (a draft's
  // icon, a later push), the project's AI review switch (the CI line's tail), the review screen.
  const threadProjectId = task.data?.projectId;
  const threadReviewOf = task.data?.kind === "review" ? (task.data.reviewOf?.taskId ?? null) : null;
  const threadAiReview = reviewSettings.data?.aiReview ?? false;
  const threadResults = useMemo(
    () =>
      threadProjectId === undefined
        ? undefined
        : {
            projectId: threadProjectId,
            aiReview: threadAiReview,
            headOf: (repoId: string) => repos?.find((repo) => repo.repoId === repoId)?.headSha ?? null,
            prsOf: (repoId: string) =>
              (repos?.find((repo) => repo.repoId === repoId)?.pullRequests ?? []).map((pr) => ({ number: pr.number, state: pr.state, draft: pr.draft, openedAt: pr.openedAt })),
            reviewHref: threadReviewOf === null ? null : `/tasks/${threadReviewOf}/review`,
          },
    [threadProjectId, threadAiReview, threadReviewOf, repos],
  );

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
  // Milestone 10 (F-151/c5): the agent takes a member's own words for a choice, so each enum offers `Something else…`.
  const freeText = task.data?.capabilities.questionFreeText ?? false;
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
          freeText={freeText}
        />
      );
    },
    [questions, taskId, agentName, isDriver, driverName, takeOverNow, takeOver.isPending, logEvents, freeText],
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
  // Milestone 9 (ticket 16): "What the agent got" is the thread's first message once the ticket's files came as message files.
  const contextInThread = (ticketContext.data?.rounds.length ?? 0) > 0;
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
      context={data.source === "ticket" ? <TicketContextRows taskId={taskId} agent={agentName} /> : null}
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
  // 2026-11-21 (F-100/c6): the code task's thread ends with its AI review's state, linking to it.
  const aiReviewTail = inLoop && data.aiReview !== null ? <AiReviewLine review={data.aiReview} /> : null;
  const roundsTail =
    rounds.data === undefined ? aiReviewTail : (
      <>
        <RoundsInThread
          taskId={taskId}
          limits={rounds.data.limits}
          cap={cap}
          capInput={{ agent: agentName, failing: failingCheck, blocking: blockingSent }}
          isDriver={isDriver}
          driver={driverName}
          keep={{ run: () => { keepWorking.mutate({ taskId }); }, pending: keepWorking.isPending, error: errorText(keepWorking.error) }}
          onTakeOver={takeOverNow}
        />
        {aiReviewTail}
      </>
    );
  // A review waiting for a runner says why and where it may run, with the way out (F-100/c6).
  const followUpWait =
    data.reviewOf !== null && data.waiting?.kind === "no-runner"
      ? followUpWaitWords(data.waiting.reason, {
          project: projectName,
          poolNames: [],
          poolName: (poolId) => (data.queue?.poolId === poolId ? data.queue.poolName : ""),
          personal: null,
        })
      : null;
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
  const eventsMarker = eventRows.data === undefined || eventRows.data.rows === 0 ? null : <span className="text-faint" data-testid="event-log-count">{eventRows.data.rows}</span>;
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

  const properties = (
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
  );

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
        <TaskTopBar
          task={data}
          expanded={expanded}
          side={codeTask ? side : null}
          onSide={(value) => { setQuery({ pane: value, view: null }); }}
          onCollapse={() => { setExpanded(false); }}
          stop={{ stopping, pending: stop.isPending, run: () => { stop.mutate({ taskId }); } }}
          local={{ load: localLoad, onOpen: () => { setLocalOpened(true); } }}
        />
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
      properties={properties}
      // Under 640px they don't stack under the thread: the Details row opens them (m2's `phone-task`).
      phoneProperties="sheet"
    >
      {/* Milestone 9 (ticket 15): the chat column is where files dropped on the page go (`data-chat-column`). */}
      <div data-chat-column className={cn("relative flex min-h-full flex-col", previewing ? "px-4 pb-4 pt-6 sm:px-7 sm:pt-[22px] lg:h-full" : "px-4 pb-5 pt-6 sm:px-9 sm:pb-4 sm:pt-[26px] xl:h-full")}>
        <div className="shrink-0">
          <div className="flex items-center gap-2.5 font-mono text-sm leading-[17px] text-faint">
            <span>{data.key} · {data.source === "prompt" ? t("taskPage.fromPrompt") : data.ticket === null ? t("taskPage.fromTicket") : t("taskPage.fromTracker", { tracker: trackerName(data.ticket.tracker) })}</span>
            {waitingTask?.startedBy.kind === "outside" ? <span className="font-sans text-ui">· <StartedInLinear task={waitingTask} /></span> : null}
            {data.kind === "code" ? null : <Chip className="font-mono text-muted">{data.kind === "refine" ? t("draft.chipRefine") : t("draft.chipReview")}</Chip>}
          </div>
          <h1 className={cn("page-title mb-1.5 mt-1 break-words", previewing && "lg:text-[24px]")}>{data.title}</h1>
          <TaskStatusLine
            task={data}
            label={noKey === null ? stateText : t("noKey.queued")}
            activity={activity}
            stoppedAt={stoppedAt}
            now={now}
            reconnecting={log.state.connection === "reconnecting"}
          />
          {inLoop ? <StageLine subState={data.subState} aiReview={aiReview} counts={data.roundCounts} needsYou={cap !== null && isDriver} held={heldNow} ciJobs={runningCiJobs(data.repos)} /> : null}
          {data.reviewOf === null ? null : <ReviewOfLine reviewOf={data.reviewOf} />}
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
            waiting={followUpWait !== null || (data.waiting?.kind === "no-runner" && wordedElsewhere.has(data.waiting.reason.code)) ? null : data.waiting}
            queue={followUpWait === null ? data.queue : null}
            boxWaiting={data.box?.waiting ?? null}
            runnerId={data.runner?.kind === "personal" ? data.runner.id : null}
            cancelledBy={cancelledBy}
            now={now}
          />
          {followUpWait === null || data.reviewOf === null ? null : <FollowUpWaiting words={followUpWait} codeTaskId={data.reviewOf.taskId} admin={organizationAdmin} />}
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
            {data.source === "ticket" && tab !== "draft" && !contextInThread ? <AgentGot files={data.contextFiles} /> : null}
          </div>
          <PhoneTaskSections
            task={{ ticket: data.ticket, sync: data.sync, repos: data.repos, contextFiles: data.contextFiles, kind: data.kind, canRetry: data.capabilities.retrySync }}
            agentGotInThread={contextInThread}
            retry={{ run: () => { retrySync.mutate({ taskId }); }, pending: retrySync.isPending }}
            details={properties}
          />
          {stop.error === null ? null : <p role="alert" className="mt-2 text-sm text-red">{errorText(stop.error)}</p>}
          {/* Milestone 10 (F-151, s1.md): the tabs 12px under the status line, 38px tall at 14px, as milestone 8's `.tab`. */}
          <UnderlineTabs
            className="mt-3 *:h-[38px] *:text-ui"
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
                    // Milestone 10 (F-151/c6): the marker follows ostra's checks and the code host's CI alike.
                    { id: "checks", label: t("taskAnswers.tabs.checks"), extra: <ChecksTabMarker marker={markerWithCi(checksMarkerOf(checksMarker.data), data.repos.flatMap((repo) => (repo.ci === null ? [] : [repo.ci])))} /> },
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
          taskKind={data.kind}
          log={log.state}
          memberId={me.data?.memberId ?? null}
          memberName={memberName}
          canSend={data.capabilities.send}
          canReopen={mode.kind === "reopen"}
          composerWords={
            mode.kind === "send" || mode.kind === "reopen"
              ? composerWordsOf(mode, {
                  agent: agentName,
                  running,
                  interrupt: showsInterrupt({ canSend: data.capabilities.send, running, canInterrupt: data.capabilities.interrupt }),
                  steers: data.capabilities.steersMidTurn,
                  waits: needs.some((need) => need.kind === "question") ? "question" : needs.some((need) => need.kind === "plan") ? "plan" : replyHint(needs, agentName) === null ? null : "reply",
                  refine: isRefine,
                })
              : null
          }
          composerNextTurn={
            <NextTurnMenu
              model={data.messageFiles.model?.name ?? data.agent?.model?.name ?? null}
              effort={effort}
              canChange={data.capabilities.setEffort && !finished}
              pending={setEffort.isPending}
              onChange={(level) => { setEffort.mutate({ taskId, level }); }}
            />
          }
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
              {/* Milestone 10 (ticket 12): an answered plan is its receipt in the plan turn's place, not the tail's. */}
              {heldNoKey ? <HeldNoKey noKey={noKey} /> : data.plan?.approved !== null ? roundsTail : (
                <div>
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
          composerFiles={{
            projectId: data.projectId,
            taskId,
            agent: agentName,
            messageFiles: data.messageFiles,
            replying: mode.kind === "send" && replyHint(needs, agentName) !== null,
          }}
          usageTurns={usageTurns}
          checkoutDirs={checkoutDirs}
          mcpServers={data.agent?.mcpServers ?? noServers}
          capMicroUsd={data.spend.unit === "usd" ? data.spend.cap : null}
          ciOf={ciOf}
          runnerName={data.runner?.name ?? null}
          title={data.title}
          {...(threadResults === undefined ? {} : { results: threadResults })}
        />
        )}
      </div>
    </PageFrame>
  );
};
