"use client";

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ArrowUpIcon, InfoIcon, PauseIcon, RefreshCcwIcon, RotateCcwIcon, SquareTerminalIcon, UserIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { AgentMessage } from "@ostra/domain/agent-message";
import { clientMessageIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import type { MemberId } from "@ostra/protocol";
import { foldTaskEvents, visibleLiveText } from "@ostra/task-view";
import type { OptimisticMessage, TaskUIMessage } from "@ostra/task-view";

import { AttachmentsProvider } from "@/components/tasks/attachments/attachments-context";
import { SubagentsBadge } from "@/components/tasks/subagents-badge";
import { SubagentsWindow } from "@/components/tasks/subagents-window";
import type { SubagentsAt } from "@/components/tasks/subagents-window";
import type { RememberResult } from "@/components/tasks/task-changes/diff-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatClock } from "@/lib/format";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { agentMessageOf, agentMessageSummary, AgentMessageMark, isAutomatic, LinearMark, UserMessageText } from "./agent-message-view";
import { toThreadMessageLike } from "./convert";
import { MessageIntentMark, SentDiffCommentsContext, sentBySeq } from "./diff-comments-message";
import { TurnUsage } from "./effort-marks";
import { AssistantText, DataRow, Reasoning, SafeLink, ToolRow } from "./renderers";
import type { TaskStreamState } from "./stream-state";
import { createTaskIndexStore, indexMessages, TaskContext, useTaskContext, useTaskMessage } from "./task-context";
import type { TaskContextValue } from "./task-context";

// The thread (ADR 0036): assistant-ui through `useExternalStoreRuntime` only, its primitives and
// render-only parts. ostra's own store feeds it: the fold of the task's events, the partial text
// and the driver's unsent messages. This folder is the only place that imports assistant-ui.

/** One mono 13px `--faint` fact in a message header, after a ` · ` when it isn't the first. */
const Meta = ({ children, dot = true, className }: { readonly children: string; readonly dot?: boolean; readonly className?: string }) => (
  <span className={cn("font-mono text-sm text-faint", className)}>
    {dot ? <span className="text-faint"> · </span> : null}
    {children}
  </span>
);

/**
 * A message's header (task.md, "Message header"): the author (14.5px, 600), then the time in mono
 * `--faint`; the agent's adds its model and a status word, a member's how it was delivered.
 */
const MessageHeader = ({ message, agentMessage }: { readonly message: TaskUIMessage; readonly agentMessage: AgentMessage | null }) => {
  const { memberName, agent, openSubagents, ticketKey } = useTaskContext();
  const meta = message.metadata;
  const time = meta?.at === undefined ? null : formatClock(meta.at);
  if (message.role === "user") {
    const delivery = meta?.author?.delivery;
    const intent = meta?.author?.intent;
    // F-072: what ostra wrote for the agent says what it is after the time, in place of its intent's tag.
    const marked = intent === "diff-comments" || intent === "linear-follow-up" || agentMessage !== null;
    const author = agentMessage !== null && isAutomatic(agentMessage) ? t("task.agentMessage.ostra") : meta?.author === undefined ? "" : memberName(meta.author.memberId);
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{author}</span>
        {/* F-072: diff comments say how many after the time (task-changes.md, "In the Activity tab"). */}
        {time === null && !marked ? null : (
          <span className="min-w-0">
            {time === null ? null : <Meta dot={false}>{time}</Meta>}
            {intent === "diff-comments" ? (
              <MessageIntentMark intent={intent} seq={meta?.author?.replayOf ?? meta?.firstSeq} />
            ) : agentMessage !== null ? (
              <AgentMessageMark message={agentMessage} intent={intent} />
            ) : intent === "linear-follow-up" ? (
              <LinearMark ticketKey={ticketKey} />
            ) : null}
          </span>
        )}
        {meta?.author?.held === true ? (
          <span className="text-sm text-red" data-testid="message-held">
            {t("task.held")}
          </span>
        ) : delivery === "queued" ? (
          <span className="text-sm text-faint">{t("task.queued")}</span>
        ) : null}
        {delivery === "after-interrupt" ? <span className="text-sm text-faint">{t("task.afterInterrupt")}</span> : null}
        {meta?.author?.reopen === true ? <span className="rounded-sm border border-line-2 px-1.5 text-xs text-muted" data-tag="reopen">{t("task.reopenTag")}</span> : null}
        {meta?.author?.replayed === true ? <span className="rounded-sm border border-line-2 px-1.5 text-xs text-muted" data-tag="replayed">{t("task.replayedTag")}</span> : null}
        {intent === undefined || intent === "message" || marked ? null : <MessageIntentMark intent={intent} seq={meta?.firstSeq} />}
        {meta?.optimistic === true ? <span className="text-sm text-faint">{t("task.sending")}</span> : null}
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{agent.name}</span>
        <span className="min-w-0">
          {time === null ? null : <Meta dot={false}>{time}</Meta>}
          {agent.model === null ? null : <Meta dot={time !== null}>{agent.model}</Meta>}
          {/* F-063 (task-plan.md, "The agent message's status word"): a plan turn reads teal `planning` while it
              runs, in the `working` slot, then `--faint` `proposed a plan`. Amber is only for what needs you. */}
          {meta?.turnState === "running" ? <Meta className="text-teal">{meta.turnMode === "plan" ? t("taskAnswers.planning") : t("task.working")}</Meta> : null}
          {meta?.turnMode === "plan" && meta.turnState === "ended" && meta.stopReason !== "cancelled" ? <Meta>{t("taskAnswers.proposedPlan")}</Meta> : null}
          {meta?.turnState === "failed" ? <Meta className="text-red">{t("task.turnFailed")}</Meta> : null}
          {meta?.stopReason === "cancelled" ? <Meta>{t("task.turnStopped")}</Meta> : null}
        </span>
        {/* F-138: the turn's subagents, nested ones included: the badge opens their window. */}
        {meta?.subagents === undefined || openSubagents === undefined ? null : (
          <SubagentsBadge tree={meta.subagents} className="ml-1" onOpen={() => { openSubagents(message.id, null); }} />
        )}
      </div>
    );
  }
  return null;
};

const MessageView = memo(({ id, fallbackRole }: { readonly id: string; readonly fallbackRole: string }) => {
  const own = useTaskMessage(id);
  const role = own?.role ?? fallbackRole;
  const meta = own?.metadata;
  const system = role === "system";
  // F-072: a message ostra wrote for the agent is drawn from what it carried, never its prompt.
  const agentMessage = useMemo(() => (own === undefined ? null : agentMessageOf(own)), [own]);
  return (
    <MessagePrimitive.Root
      data-message-id={id}
      data-role={role}
      data-turn-state={meta?.turnState}
      data-optimistic={meta?.optimistic === true ? "true" : undefined}
      data-first-seq={meta?.firstSeq}
      data-last-seq={meta?.lastSeq}
      className={cn("flex gap-3 rounded-md data-[event-focus=true]:bg-sel", system ? "py-0.5 pl-10" : "py-2.5")}
    >
      {system ? null : (
        <span className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full border border-line-2 text-muted">
          {role !== "user" ? (
            <SquareTerminalIcon className="size-[14px] stroke-[1.75]" />
          ) : agentMessage !== null && isAutomatic(agentMessage) ? (
            <RefreshCcwIcon className="size-[14px] stroke-[1.75]" />
          ) : (
            <UserIcon className="size-[14px] stroke-[1.75]" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {own === undefined ? null : <MessageHeader message={own} agentMessage={agentMessage} />}
        <MessagePrimitive.Parts>
          {({ part }) => {
            switch (part.type) {
              case "text":
                return role === "user" ? (
                  <UserMessageText text={part.text} intent={meta?.author?.intent} diffSeq={meta?.author?.replayOf ?? meta?.firstSeq} agentMessage={agentMessage} />
                ) : (
                  <AssistantText streaming={part.status.type === "running"} />
                );
              case "reasoning":
                return <Reasoning text={part.text} streaming={part.status.type === "running"} />;
              case "tool-call":
                return <ToolRow toolCallId={part.toolCallId} />;
              case "data":
                return <DataRow id={part.id ?? ""} />;
              case "source":
                return (
                  <div className="text-sm" data-part="source">
                    <SafeLink href={part.url}>{part.title ?? part.url}</SafeLink>
                  </div>
                );
              case "image":
                // An image the agent made is shown only when it's inline data: never a remote request.
                return part.image.startsWith("data:image/") ? (
                  <img data-part="image" src={part.image} alt="" className="my-1 max-h-80 rounded-lg border border-line" />
                ) : (
                  <span className="text-sm text-faint">{t("task.imageRemote")}</span>
                );
              case "file":
              case "audio":
              case "generative-ui":
                return null;
              default:
                return part satisfies never;
            }
          }}
        </MessagePrimitive.Parts>
        {/* F-084: each turn shows its own tokens once it ended, from the key proxy's counts; "≈" marks an estimate. */}
        {/* F-137: with the level it ran at, its reasoning tokens, and the clamp's line when it moved the level. */}
        {role === "assistant" && meta !== undefined && meta.turnState !== "running" ? <TurnUsage meta={meta} /> : null}
      </div>
    </MessagePrimitive.Root>
  );
});
MessageView.displayName = "MessageView";

/**
 * The composer, pinned under the thread (task.md, "Composer"). ostra's own Send: assistant-ui's stock
 * Send never fires while a turn runs (spike 7, ADR 0036). `Interrupt and send` shows only while a turn
 * runs and the driver may interrupt it.
 */
const Composer = ({ interrupt, onSend, reopen = false, hint = null }: { readonly interrupt: boolean; readonly onSend: (text: string, interrupt: boolean) => Promise<void>; readonly reopen?: boolean; readonly hint?: string | null }) => {
  const text = useAuiState((state) => state.composer.text);
  const aui = useAui();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = (interrupt: boolean) => {
    const value = text.trim();
    if (value === "" || busy) return;
    setError(null);
    setBusy(true);
    onSend(value, interrupt).then(
      () => { aui.composer.setText(""); setBusy(false); },
      (cause: unknown) => { setError(cause instanceof Error ? cause.message : t("errors.unknown")); setBusy(false); },
    );
  };
  return (
    <ComposerPrimitive.Root data-part="composer" className="focus-box rounded-lg border border-control-line bg-surface px-3.5 py-3" onSubmit={(event) => { event.preventDefault(); send(false); }}>
      <ComposerPrimitive.Input
        onKeyDown={(event) => {
          // Ticket 16: Escape leaves the composer (Enter sends, Shift+Enter is a new line).
          if (event.key === "Escape") event.currentTarget.blur();
        }}
        aria-label={t("task.composer.label")} placeholder={reopen ? t("taskPage.composer.reopenPlaceholder") : t("task.composer.placeholder")} rows={2} className="block w-full resize-none bg-transparent text-body text-text placeholder:text-faint focus:outline-none focus-visible:outline-none" />
      {error === null ? null : <p role="alert" className="text-sm text-red">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-faint">
          <InfoIcon className="size-[13px] shrink-0 stroke-[1.75]" /> <span className="truncate">{hint ?? t("task.composer.hint")}</span>
        </span>
        {interrupt ? (
          <Button type="button" onClick={() => { send(true); }} disabled={text.trim() === ""}>
            <PauseIcon /> {t("task.composer.interruptAndSend")}
          </Button>
        ) : null}
        {reopen ? (
          <Button type="button" variant="primary" onClick={() => { send(false); }} disabled={text.trim() === "" || busy} data-action="reopen">
            <RotateCcwIcon /> {busy ? t("taskPage.composer.reopening") : t("taskPage.composer.reopen")}
          </Button>
        ) : (
          <Button type="button" variant="primary" onClick={() => { send(false); }} disabled={text.trim() === ""} data-action="send">
            <ArrowUpIcon /> {t("task.composer.send")}
          </Button>
        )}
      </div>
    </ComposerPrimitive.Root>
  );
};

export type TaskThreadProps = {
  readonly taskId: TaskId;
  /** The task's project, for the budget's held row (F-037). */
  readonly projectName?: string;
  /** The task's ticket's key, for a Linear follow-up's header; `null` for a prompt task. */
  readonly ticketKey?: string | null;
  readonly log: TaskStreamState;
  readonly memberId: MemberId | null;
  readonly memberName: (memberId: string) => string;
  readonly canSend: boolean;
  /** The driver may interrupt the running turn (`capabilities.interrupt`). */
  readonly canInterrupt: boolean;
  readonly running: boolean;
  /** The agent's display name and model, for its message headers. */
  readonly agent: { readonly name: string; readonly model: string | null };
  readonly approvalSummary: (approvalId: string) => string | null;
  /** Milestone 3 (ticket 43): the answerable cards and the worded receipts, from `tasks.get`. */
  readonly approvalCard?: (approvalId: string) => ReactNode;
  readonly approvalReceipt?: (approvalId: string) => string | null;
  readonly approvalLostRace?: (approvalId: string) => boolean;
  readonly questionCard?: (questionId: string) => ReactNode;
  /** After the last message, inside the scroll: the plan waiting for the driver, or its receipt, and what needs you. */
  readonly tail?: ReactNode;
  /** The polite live region that reads out a need as it appears (always mounted beside the thread). */
  readonly live?: ReactNode;
  /** In place of the composer when the viewer can't send: the take-over line, or nothing. */
  readonly notDriver?: ReactNode;
  /** The composer reopens the task (`tasks.reopen`) instead of sending (ticket 36). */
  readonly canReopen?: boolean;
  /** The composer's hint line, when the task page has a better one than the agent's. */
  readonly composerHint?: string | null;
  /** A line in the composer's place when neither send nor reopen applies (a merged task). */
  readonly instead?: ReactNode;
  readonly hasEarlier: boolean;
  readonly loadEarlier: () => Promise<void>;
  /** Called after the fold with how long it took, for the render budget's record. */
  readonly onFold?: (ms: number, messages: number) => void;
};

export const TaskThread = ({ taskId, projectName, ticketKey = null, log, memberId, memberName, canSend, canInterrupt, running, agent, approvalSummary, approvalCard, approvalReceipt, approvalLostRace, questionCard, tail, live, notDriver, canReopen = false, composerHint = null, instead, hasEarlier, loadEarlier, onFold }: TaskThreadProps) => {
  const trpc = useTRPC();
  const [optimistic, setOptimistic] = useState<readonly OptimisticMessage[]>([]);
  const previous = useRef<readonly TaskUIMessage[]>([]);
  // F-138: the subagents window, on a turn, and what opened it (the focus goes back there).
  const [subagentsAt, setSubagentsAt] = useState<(SubagentsAt & { readonly opener: HTMLElement | null }) | null>(null);
  const openSubagents = useCallback((messageId: string, subagentId: string | null) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSubagentsAt({ messageId, subagentId, opener });
  }, []);
  const send = useMutation(trpc.tasks.send.mutationOptions());
  const reopen = useMutation(trpc.tasks.reopen.mutationOptions());
  const remember = useMutation(trpc.memory.rememberThis.mutationOptions());

  // F-080 (ticket 35): `?event={seq}` opens the thread at the message holding that event (a search hit).
  const focusParam = Number.parseInt(useSearchParams().get("event") ?? "", 10);
  const focusSeq = Number.isInteger(focusParam) && focusParam > 0 ? focusParam : null;
  const focused = useRef<number | null>(null);

  // F-121: how many pictures the log holds, so the thread reads the attachments again when one comes.
  const attachmentsAdded = useMemo(() => log.events.filter(({ event }) => event.kind === "attachment.added").length, [log.events]);

  const messages = useMemo(() => {
    const started = performance.now();
    const next = foldTaskEvents(log.events, visibleLiveText(log.live), { optimistic, previous: previous.current });
    onFold?.(performance.now() - started, next.length);
    previous.current = next;
    return next;
  }, [log.events, log.live, optimistic, onFold]);

  // F-072: a diff-comments message is drawn from the comments it carried (`diff.comments.list`), read
  // only once the thread has one. A task's notice refreshes them (`change-scopes.ts`); a message whose
  // comments aren't in the list yet asks once more, in case its notice came before the list was read.
  const diffCommentSeqs = useMemo(
    () => log.events.flatMap(({ seq, event }) => (event.kind === "user.message" && event.intent === "diff-comments" ? [seq] : [])),
    [log.events],
  );
  const sentList = useQuery(trpc.diff.comments.list.queryOptions({ taskId }, { enabled: diffCommentSeqs.length > 0 }));
  const sentDiffComments = useMemo(() => (sentList.data === undefined ? null : sentBySeq(sentList.data.comments)), [sentList.data]);
  const { refetch: refetchSent, isFetching: fetchingSent } = sentList;
  const askedAgain = useRef(new Set<number>());
  useEffect(() => {
    if (sentDiffComments === null || fetchingSent) return;
    const missing = diffCommentSeqs.filter((seq) => !sentDiffComments.has(seq) && !askedAgain.current.has(seq));
    if (missing.length === 0) return;
    for (const seq of missing) askedAgain.current.add(seq);
    void refetchSent();
  }, [diffCommentSeqs, sentDiffComments, fetchingSent, refetchSent]);

  // Forget an optimistic send once its committed message is in the log.
  useEffect(() => {
    const committed = new Set<string>();
    for (const { event } of log.events) if (event.kind === "user.message") committed.add(event.clientMessageId);
    setOptimistic((list) => (list.some((m) => committed.has(m.clientMessageId)) ? list.filter((m) => !committed.has(m.clientMessageId)) : list));
  }, [log.events]);

  const sendText = useCallback(
    async (text: string, interrupt: boolean) => {
      if (memberId === null) return;
      const clientMessageId = clientMessageIdSchema.parse(crypto.randomUUID());
      setOptimistic((list) => [...list, { clientMessageId, memberId, text, delivery: interrupt ? "after-interrupt" : running ? "queued" : "immediate" }]);
      try {
        if (canReopen && !canSend) await reopen.mutateAsync({ taskId, clientMessageId, text });
        else await send.mutateAsync({ taskId, clientMessageId, text, delivery: interrupt ? "interrupt" : "queue" });
      } catch (cause) {
        setOptimistic((list) => list.filter((m) => m.clientMessageId !== clientMessageId));
        throw new Error(errorText({ message: cause instanceof Error ? cause.message : "", data: null }) ?? t("errors.unknown"));
      }
    },
    [memberId, running, send, reopen, canReopen, canSend, taskId],
  );

  const runtime = useExternalStoreRuntime<TaskUIMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isRunning: running,
    isDisabled: !canSend && !canReopen,
    // ostra's own Send button sends; this only runs if assistant-ui's composer submits on Enter.
    onNew: async (message) => {
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      if (text.trim() !== "") await sendText(text, false);
    },
  });

  // Rows read their own part from a store whose identity never changes (spike 7).
  const store = useMemo(() => createTaskIndexStore(), []);
  const index = useMemo(() => {
    const built = indexMessages(messages);
    store.set(built);
    return built;
  }, [messages, store]);
  useLayoutEffect(() => {
    store.publish();
  }, [index, store]);
  const agentName = agent.name;
  const agentModel = agent.model;
  const { mutateAsync: rememberAsync } = remember;
  // F-111: "Remember this" on an accepted `@ostra` comment, by its event, with the member's words.
  const rememberPrComment = useCallback(
    async (seq: number, draft: { readonly title: string; readonly body: string }): Promise<RememberResult> => {
      try {
        await rememberAsync({ source: { taskId, prCommentEventSeq: seq }, title: draft.title, body: draft.body });
        return { kind: "proposed" };
      } catch (cause) {
        return { kind: "refused", message: errorText({ message: cause instanceof Error ? cause.message : "", data: null }) ?? t("errors.unknown") };
      }
    },
    [rememberAsync, taskId],
  );
  const context = useMemo<TaskContextValue>(
    () => ({
      store,
      memberName,
      agent: { name: agentName, model: agentModel },
      approvalSummary,
      rememberPrComment,
      openSubagents,
      ...(approvalCard === undefined ? {} : { approvalCard }),
      ...(approvalReceipt === undefined ? {} : { approvalReceipt }),
      ...(approvalLostRace === undefined ? {} : { approvalLostRace }),
      ...(questionCard === undefined ? {} : { questionCard }),
      ...(projectName === undefined ? {} : { projectName }),
      ...(ticketKey === null ? {} : { ticketKey }),
    }),
    [store, memberName, agentName, agentModel, approvalSummary, rememberPrComment, openSubagents, approvalCard, approvalReceipt, approvalLostRace, questionCard, projectName, ticketKey],
  );

  // F-138: the member's message the turn answered, for the main agent's pane of the window.
  const askedOf = (messageId: string): { readonly name: string; readonly text: string } | null => {
    const at = messages.findIndex((message) => message.id === messageId);
    for (let i = at - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === "user") {
        const name = message.metadata?.author === undefined ? "" : memberName(message.metadata.author.memberId);
        // F-072: a fenced prompt is the agent's to read; the window says what the member sent.
        if (message.metadata?.author?.intent === "diff-comments") {
          const sent = sentDiffComments?.get(message.metadata.author.replayOf ?? message.metadata.firstSeq);
          return { name, text: sent === undefined || sent.length === 0 ? t("taskAnswers.intent.diff-comments") : plural(sent.length, "task.diffComments.one", "task.diffComments.other") };
        }
        const agentMessage = agentMessageOf(message);
        if (agentMessage !== null) {
          return { name: isAutomatic(agentMessage) ? t("task.agentMessage.ostra") : name, text: agentMessageSummary(agentMessage) };
        }
        const text = message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        return { name, text };
      }
    }
    return null;
  };

  useEffect(() => {
    if (focusSeq === null || focused.current === focusSeq) return;
    let frame = 0;
    let tries = 0;
    const find = () => {
      const holder = [...document.querySelectorAll<HTMLElement>("[data-first-seq]")].find((element) => {
        const first = Number(element.dataset["firstSeq"]);
        const last = Number(element.dataset["lastSeq"]);
        return first <= focusSeq && focusSeq <= last;
      });
      if (holder === undefined) {
        // The runtime draws the messages a frame or two after the fold; look again for a moment.
        tries += 1;
        if (tries < 30) frame = requestAnimationFrame(find);
        return;
      }
      focused.current = focusSeq;
      for (const element of document.querySelectorAll<HTMLElement>("[data-event-focus]")) element.removeAttribute("data-event-focus");
      holder.dataset["eventFocus"] = "true";
      holder.scrollIntoView({ block: "center" });
    };
    find();
    return () => { cancelAnimationFrame(frame); };
  }, [focusSeq, messages]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TaskContext.Provider value={context}>
        <AttachmentsProvider taskId={taskId} added={attachmentsAdded} agentName={agentName}>
        <SentDiffCommentsContext.Provider value={sentDiffComments}>
          <ThreadPrimitive.Root data-part="thread" className="flex min-h-0 flex-1 flex-col">
            {live}
            <ThreadPrimitive.Viewport autoScroll={focusSeq === null} className="min-h-0 flex-1 overflow-y-auto">
              {hasEarlier ? (
                <div className="py-2">
                  <Button size="sm" variant="ghost" data-action="load-earlier" onClick={() => void loadEarlier()}>
                    {t("task.loadEarlier")}
                  </Button>
                </div>
              ) : null}
              <ThreadPrimitive.Messages>{({ message }) => <MessageView id={message.id} fallbackRole={message.role} />}</ThreadPrimitive.Messages>
              {tail}
            </ThreadPrimitive.Viewport>
            {canSend || canReopen ? (
              <div className="shrink-0 pt-3">
                <Composer interrupt={canSend && running && canInterrupt} onSend={sendText} reopen={!canSend} hint={composerHint} />
              </div>
            ) : instead !== undefined ? (
              instead
            ) : notDriver === undefined ? null : (
              <div className="shrink-0 pt-3 text-sm" data-part="not-driver">{notDriver}</div>
            )}
          </ThreadPrimitive.Root>
          {subagentsAt === null ? null : (
            <SubagentsWindow
              key={`${subagentsAt.messageId}:${subagentsAt.subagentId ?? ""}`}
              at={subagentsAt}
              opener={subagentsAt.opener}
              asked={askedOf(subagentsAt.messageId)}
              onClose={() => { setSubagentsAt(null); }}
            />
          )}
        </SentDiffCommentsContext.Provider>
        </AttachmentsProvider>
      </TaskContext.Provider>
    </AssistantRuntimeProvider>
  );
};
