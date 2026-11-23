"use client";

import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { clientMessageIdSchema } from "@ostra/protocol";
import type { SessionId, TaskId, TaskKind } from "@ostra/protocol";
import type { MemberId } from "@ostra/protocol";
import { foldTaskEvents, turnOrdinalsOf, turnSpendOf, visibleLiveText } from "@ostra/task-view";
import type { OptimisticMessage, TaskUIMessage } from "@ostra/task-view";

import { AttachmentsProvider, useAttachments as useThreadAttachments } from "@/components/tasks/attachments/attachments-context";
import { ThreadTicketContext } from "@/components/tasks/attachments/ticket-context-thread";
import { SubagentsWindow } from "@/components/tasks/subagents-window";
import type { SubagentsAt } from "@/components/tasks/subagents-window";
import type { RememberResult } from "@/components/tasks/task-changes/diff-view";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { plural, t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { agentMessageOf, agentMessageSummary, isAutomatic } from "./agent-message-view";
import { toThreadMessageLike } from "./convert";
import { SentDiffCommentsContext, sentBySeq } from "./diff-comments-message";
import type { TaskStreamState } from "./stream-state";
import { createTaskIndexStore, indexMessages, TaskContext, useTaskContext, useTaskMessage } from "./task-context";
import type { TaskContextValue } from "./task-context";
import { answersOf } from "./thread/answers";
import { Bubble } from "./thread/bubble";
import { Composer } from "./thread/composer";
import type { ComposerFiles, SentFiles } from "./thread/composer";
import { showsInterrupt } from "./thread/composer-words";
import type { ComposerWords } from "./thread/composer-words";
import { Divider } from "./thread/divider";
import { ThreadParts } from "./thread/thread-context";
import type { ThreadPartsValue } from "./thread/thread-context";
import { TurnItems } from "./thread/turn-items";
import { pricedTurnsOf } from "./thread/turn-spend";
import type { UsageTurn } from "./thread/turn-spend";
import type { HeadCi } from "./thread/words";

// The thread (ADR 0036): assistant-ui through `useExternalStoreRuntime` only, its primitives and
// render-only parts. ostra's own store feeds it: the fold of the task's events, the partial text
// and the driver's unsent messages. This folder is the only place that imports assistant-ui.

/**
 * One message of the thread (milestone 10, F-151, ticket 09): a member's as its bubble
 * (`thread/bubble.tsx`), an agent's turn or a row outside any turn as its items, each through its
 * part (`thread/turn-items.tsx`). No avatar, no header, no token line: the run's line carries the
 * turn's time, and its numbers are in the opened run's footer, the time's tooltip and the panel.
 */
export const MessageView = memo(({ id, fallbackRole, dayAt = null }: { readonly id: string; readonly fallbackRole: string; readonly dayAt?: number | null }) => {
  const own = useTaskMessage(id);
  const { memberName } = useTaskContext();
  const taskTitle = useContext(ThreadParts)?.taskTitle ?? null;
  const role = own?.role ?? fallbackRole;
  const meta = own?.metadata;
  const attachments = useThreadAttachments();
  // F-072: a message ostra wrote for the agent is drawn from what it carried, never its prompt.
  const agentMessage = useMemo(() => (own === undefined ? null : agentMessageOf(own)), [own]);
  // F-149: a ticket task's first message is "What the agent got", drawn from the ticket's context.
  const ticketStart = attachments?.ticketContext?.rounds[0]?.messageSeq;
  // Milestone 10 (ticket 12): a day divider before the first message of a new day (`Yesterday`, `Mon 17 Nov`).
  const day = dayAt === null ? null : <Divider divider={{ kind: "day", at: dayAt }} now={Date.now()} />;
  if (role === "user" && ticketStart !== undefined && ticketStart !== null && meta?.firstSeq === ticketStart && attachments !== null) {
    return (
      <>
        {day}
        <div data-message-id={id} data-role="ticket-context" data-first-seq={meta.firstSeq} data-last-seq={meta.lastSeq}>
          <ThreadTicketContext taskId={attachments.taskId} now={Date.now()} by={meta.author === undefined ? null : memberName(meta.author.memberId)} at={meta.at ?? null} title={taskTitle} />
        </div>
      </>
    );
  }
  return (
    <>
      {day}
      <MessagePrimitive.Root
        data-message-id={id}
        data-role={role}
        data-turn-state={meta?.turnState}
        data-optimistic={meta?.optimistic === true ? "true" : undefined}
        data-first-seq={meta?.firstSeq}
        data-last-seq={meta?.lastSeq}
        className="rounded-md data-[event-focus=true]:bg-sel"
      >
        {own === undefined ? null : role === "user" ? <Bubble message={own} agentMessage={agentMessage} /> : <TurnItems message={own} />}
      </MessagePrimitive.Root>
    </>
  );
});
MessageView.displayName = "MessageView";

/**
 * "What the agent got" at the thread's start while the ticket is still being read, or for a ticket
 * task started outside the panel, whose first read has no message of its own to take the place of.
 */
const TicketContextAtStart = ({ taskId }: { readonly taskId: TaskId }) => {
  const attachments = useThreadAttachments();
  const title = useContext(ThreadParts)?.taskTitle ?? null;
  const view = attachments?.ticketContext ?? null;
  if (view === null) return null;
  const first = view.rounds[0];
  if (first !== undefined && first.messageSeq !== null) return null;
  return <ThreadTicketContext taskId={taskId} now={Date.now()} title={title} />;
};

export type TaskThreadProps = {
  readonly taskId: TaskId;
  /** The task's kind: only a review task's turn hands in a review (milestone 10, F-151). */
  readonly taskKind: TaskKind;
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
  /** Milestone 10 (ticket 11): the composer's placeholder, the hint under it and Send's name (`composerWordsOf`). */
  readonly composerWords?: ComposerWords | null;
  /** Milestone 10 (ticket 11, F-137): under the composer at its right, the next turn's model and level (`NextTurnMenu`). */
  readonly composerNextTurn?: ReactNode;
  /** A line in the composer's place when neither send nor reopen applies (a merged task). */
  readonly instead?: ReactNode;
  readonly hasEarlier: boolean;
  readonly loadEarlier: () => Promise<void>;
  /** Called after the fold with how long it took, for the render budget's record. */
  readonly onFold?: (ms: number, messages: number) => void;
  /** Milestone 9 (ticket 15): what the composer needs to take files; `null` takes none. */
  readonly composerFiles?: ComposerFiles | null;
  /**
   * Milestone 10 (F-151): what the compact thread reads of the task, from `tasks.get`: each turn's
   * figures (`usage.turns`, for the fold's spend and turn numbers), its repos' checkout folders
   * and CI, its agent's MCP servers, and its spend cap.
   */
  readonly usageTurns?: readonly UsageTurn[];
  readonly checkoutDirs?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly capMicroUsd?: number | null;
  readonly ciOf?: (repoId: string) => HeadCi | null;
  /** Ticket 12: the task's runner now (its active lease's), for how its last session came back; and its title, for "What the agent got". */
  readonly runnerName?: string | null;
  readonly title?: string;
};

/** The first message of each day after the first (the day divider's place, milestone 2's rule), with its time. */
export const dayBreaksOf = (messages: readonly TaskUIMessage[]): ReadonlyMap<string, number> => {
  const breaks = new Map<string, number>();
  let previous: string | null = null;
  for (const message of messages) {
    const at = message.metadata?.at;
    if (at === undefined) continue;
    const day = new Date(at).toDateString();
    if (previous !== null && day !== previous) breaks.set(message.id, at);
    previous = day;
  }
  return breaks;
};

const NO_TURNS: readonly UsageTurn[] = [];
const NO_NAMES: readonly string[] = [];
const noCi = (): HeadCi | null => null;

export const TaskThread = ({ taskId, taskKind, projectName, ticketKey = null, log, memberId, memberName, canSend, canInterrupt, running, agent, approvalSummary, approvalCard, approvalReceipt, approvalLostRace, questionCard, tail, live, notDriver, canReopen = false, composerWords = null, composerNextTurn = null, instead, hasEarlier, loadEarlier, onFold, composerFiles = null, usageTurns = NO_TURNS, checkoutDirs = NO_NAMES, mcpServers = NO_NAMES, capMicroUsd = null, ciOf = noCi, runnerName = null, title }: TaskThreadProps) => {
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

  // Milestone 9 (ticket 16): the task's files, so a removed one's chip loses its link, and how many messages brought files.
  const taskFiles = useQuery(trpc.tasks.files.queryOptions({ taskId }));
  const removedFiles = useMemo(() => new Set((taskFiles.data?.files ?? []).flatMap((file) => (file.downloadPath === null ? [file.fileId] : []))), [taskFiles.data]);
  const filesAdded = useMemo(() => log.events.filter(({ event }) => event.kind === "user.message" && ((event.files?.length ?? 0) > 0 || event.intent === "ticket-update")).length, [log.events]);
  const messageOf = useCallback(
    (seq: number) => {
      const found = log.events.find((stored) => stored.seq === seq);
      return found?.event.kind === "user.message" ? { memberName: memberName(found.event.memberId), at: found.at, imagesNotSent: found.event.imagesNotSent ?? null } : null;
    },
    [log.events, memberName],
  );

  // Milestone 10 (F-151): each turn's spend and its number in the task, from `tasks.get`'s turns,
  // matched to the log's turns (core's turn rows have IDs of their own).
  const priced = useMemo(() => pricedTurnsOf(log.events, usageTurns), [log.events, usageTurns]);
  const turnSpend = useMemo(() => turnSpendOf(priced), [priced]);
  const turnOrdinals = useMemo(() => turnOrdinalsOf(priced), [priced]);
  const messages = useMemo(() => {
    const started = performance.now();
    const next = foldTaskEvents(log.events, visibleLiveText(log.live), { optimistic, previous: previous.current, removedFiles, taskKind, turnSpend, turnOrdinals });
    onFold?.(performance.now() - started, next.length);
    previous.current = next;
    return next;
  }, [log.events, log.live, optimistic, onFold, removedFiles, taskKind, turnSpend, turnOrdinals]);

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
    async (text: string, interrupt: boolean, sent: SentFiles = { fileIds: [], previews: [] }) => {
      if (memberId === null) return;
      const clientMessageId = clientMessageIdSchema.parse(crypto.randomUUID());
      setOptimistic((list) => [...list, { clientMessageId, memberId, text, delivery: interrupt ? "after-interrupt" : running ? "queued" : "immediate", ...(sent.previews.length === 0 ? {} : { files: sent.previews }) }]);
      const fileIds = sent.fileIds.length === 0 ? {} : { fileIds: [...sent.fileIds] };
      try {
        if (canReopen && !canSend) await reopen.mutateAsync({ taskId, clientMessageId, ...(text === "" ? {} : { text }), ...fileIds });
        else await send.mutateAsync({ taskId, clientMessageId, text, delivery: interrupt ? "interrupt" : "queue", ...fileIds });
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

  // Ticket 12: what members answered (the plan's receipts and markers, late answers), read from the log;
  // the runner the task's last session came back on; and a day divider where the day changes.
  const answers = useMemo(() => answersOf(log.events), [log.events]);
  const lastSession = useMemo(() => messages.findLast((message) => message.metadata?.sessionId !== undefined)?.metadata?.sessionId, [messages]);
  const runnerOf = useCallback((sessionId: SessionId | undefined) => (sessionId !== undefined && sessionId === lastSession ? runnerName : null), [lastSession, runnerName]);
  const dayBreaks = useMemo(() => dayBreaksOf(messages), [messages]);
  const threadParts = useMemo<ThreadPartsValue>(
    () => ({ taskKind, workspace: { taskId, checkoutDirs, mcpServers }, project: projectName ?? "", capMicroUsd, ciOf, answers, runnerOf, ...(title === undefined ? {} : { taskTitle: title }) }),
    [taskKind, taskId, checkoutDirs, mcpServers, projectName, capMicroUsd, ciOf, answers, runnerOf, title],
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
        <AttachmentsProvider taskId={taskId} added={attachmentsAdded} filesAdded={filesAdded} agentName={agentName} messageOf={messageOf}>
        <SentDiffCommentsContext.Provider value={sentDiffComments}>
          <ThreadParts.Provider value={threadParts}>
          <ThreadPrimitive.Root data-part="thread" className="flex min-h-0 flex-1 flex-col">
            {live}
            <ThreadPrimitive.Viewport autoScroll={focusSeq === null} className="min-h-0 flex-1 overflow-y-auto">
              {/* Milestone 10 (F-151, parts.md part 1): one 720px column, left-aligned in the page's padding;
                  a member's message 24px under what came before, 8px when it opens the column. */}
              <div data-part="thread-column" className="max-w-[720px] pb-2.5 pt-1.5 [&>[data-message-id]:first-child>[data-part=bubble]]:mt-2">
                {hasEarlier ? (
                  <div className="py-2">
                    <Button size="sm" variant="ghost" data-action="load-earlier" onClick={() => void loadEarlier()}>
                      {t("task.loadEarlier")}
                    </Button>
                  </div>
                ) : null}
                {hasEarlier ? null : <TicketContextAtStart taskId={taskId} />}
                <ThreadPrimitive.Messages>{({ message }) => <MessageView id={message.id} fallbackRole={message.role} dayAt={dayBreaks.get(message.id) ?? null} />}</ThreadPrimitive.Messages>
                {tail}
              </div>
            </ThreadPrimitive.Viewport>
            {canSend || canReopen ? (
              // parts.md part 1: the box sits right under the thread's 10px end, the composer as wide as the column.
              <div className="max-w-[720px] shrink-0">
                <Composer interrupt={showsInterrupt({ canSend, running, canInterrupt })} onSend={sendText} reopen={!canSend} words={composerWords} nextTurn={composerNextTurn} files={composerFiles} />
              </div>
            ) : instead !== undefined ? (
              <div className="max-w-[720px] shrink-0">{instead}</div>
            ) : notDriver === undefined ? null : (
              <div className="max-w-[720px] shrink-0 pt-3 text-sm" data-part="not-driver">{notDriver}</div>
            )}
          </ThreadPrimitive.Root>
          </ThreadParts.Provider>
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
