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
import { useMutation } from "@tanstack/react-query";
import { ArrowUpIcon, InfoIcon, PauseIcon, SquareTerminalIcon, UserIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { clientMessageIdSchema } from "@ostra/protocol";
import type { TaskId } from "@ostra/protocol";
import type { MemberId } from "@ostra/protocol";
import { foldTaskEvents, visibleLiveText } from "@ostra/task-view";
import type { OptimisticMessage, TaskUIMessage } from "@ostra/task-view";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/messages";
import { useTRPC } from "@/lib/trpc";

import { toThreadMessageLike } from "./convert";
import { AssistantText, DataRow, Reasoning, SafeLink, ToolRow } from "./renderers";
import type { TaskStreamState } from "./stream-state";
import { createTaskIndexStore, indexMessages, TaskContext, useTaskContext, useTaskMessage } from "./task-context";
import type { TaskContextValue } from "./task-context";

// The thread (ADR 0036): assistant-ui through `useExternalStoreRuntime` only, its primitives and
// render-only parts. ostra's own store feeds it: the fold of the task's events, the partial text
// and the driver's unsent messages. This folder is the only place that imports assistant-ui.

/** One mono 12px `--faint` fact in a message header, after a ` · ` when it isn't the first. */
const Meta = ({ children, dot = true, className }: { readonly children: string; readonly dot?: boolean; readonly className?: string }) => (
  <span className={cn("font-mono text-sm text-faint", className)}>
    {dot ? <span className="text-faint"> · </span> : null}
    {children}
  </span>
);

/**
 * A message's header (task.md, "Message header"): the author (13px, 600), then the time in mono
 * `--faint`; the agent's adds its model and a status word, a member's how it was delivered.
 */
const MessageHeader = ({ message }: { readonly message: TaskUIMessage }) => {
  const { memberName, agent } = useTaskContext();
  const meta = message.metadata;
  const time = meta?.at === undefined ? null : formatClock(meta.at);
  if (message.role === "user") {
    const delivery = meta?.author?.delivery;
    return (
      <div className="flex items-baseline gap-2">
        <span className="font-semibold">{meta?.author === undefined ? "" : memberName(meta.author.memberId)}</span>
        {time === null ? null : <Meta dot={false}>{time}</Meta>}
        {delivery === "queued" ? <span className="text-sm text-faint">{t("task.queued")}</span> : null}
        {delivery === "after-interrupt" ? <span className="text-sm text-faint">{t("task.afterInterrupt")}</span> : null}
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
          {meta?.turnState === "running" ? <Meta className="text-teal">{t("task.working")}</Meta> : null}
          {meta?.turnState === "failed" ? <Meta className="text-red">{t("task.turnFailed")}</Meta> : null}
          {meta?.stopReason === "cancelled" ? <Meta>{t("task.turnStopped")}</Meta> : null}
        </span>
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
  return (
    <MessagePrimitive.Root
      data-message-id={id}
      data-role={role}
      data-turn-state={meta?.turnState}
      data-optimistic={meta?.optimistic === true ? "true" : undefined}
      className={cn("flex gap-3", system ? "py-0.5 pl-10" : "py-2.5")}
    >
      {system ? null : (
        <span className="mt-0.5 inline-grid size-7 shrink-0 place-items-center rounded-full border border-line-2 text-muted">
          {role === "user" ? <UserIcon className="size-[14px] stroke-[1.75]" /> : <SquareTerminalIcon className="size-[14px] stroke-[1.75]" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {own === undefined ? null : <MessageHeader message={own} />}
        <MessagePrimitive.Parts>
          {({ part }) => {
            switch (part.type) {
              case "text":
                return role === "user" ? (
                  <p data-part="user-text" className="whitespace-pre-wrap break-words">{part.text}</p>
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
const Composer = ({ interrupt, onSend }: { readonly interrupt: boolean; readonly onSend: (text: string, interrupt: boolean) => Promise<void> }) => {
  const text = useAuiState((state) => state.composer.text);
  const aui = useAui();
  const [error, setError] = useState<string | null>(null);
  const send = (interrupt: boolean) => {
    const value = text.trim();
    if (value === "") return;
    setError(null);
    onSend(value, interrupt).then(
      () => { aui.composer.setText(""); },
      (cause: unknown) => { setError(cause instanceof Error ? cause.message : t("errors.unknown")); },
    );
  };
  return (
    <ComposerPrimitive.Root data-part="composer" className="rounded-lg border border-line-2 bg-surface px-3.5 py-3 focus-within:border-[#34363a]" onSubmit={(event) => { event.preventDefault(); send(false); }}>
      <ComposerPrimitive.Input aria-label={t("task.composer.label")} placeholder={t("task.composer.placeholder")} rows={2} className="block w-full resize-none bg-transparent text-body text-text placeholder:text-faint focus:outline-none focus-visible:outline-none" />
      {error === null ? null : <p role="alert" className="text-sm text-red">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-faint">
          <InfoIcon className="size-[13px] shrink-0 stroke-[1.75]" /> <span className="truncate">{t("task.composer.hint")}</span>
        </span>
        {interrupt ? (
          <Button type="button" onClick={() => { send(true); }} disabled={text.trim() === ""}>
            <PauseIcon /> {t("task.composer.interruptAndSend")}
          </Button>
        ) : null}
        <Button type="button" variant="primary" onClick={() => { send(false); }} disabled={text.trim() === ""} data-action="send">
          <ArrowUpIcon /> {t("task.composer.send")}
        </Button>
      </div>
    </ComposerPrimitive.Root>
  );
};

export type TaskThreadProps = {
  readonly taskId: TaskId;
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
  /** In place of the composer when the viewer can't send: the take-over line, or nothing. */
  readonly notDriver?: ReactNode;
  readonly hasEarlier: boolean;
  readonly loadEarlier: () => Promise<void>;
  /** Called after the fold with how long it took, for the render budget's record. */
  readonly onFold?: (ms: number, messages: number) => void;
};

export const TaskThread = ({ taskId, log, memberId, memberName, canSend, canInterrupt, running, agent, approvalSummary, notDriver, hasEarlier, loadEarlier, onFold }: TaskThreadProps) => {
  const trpc = useTRPC();
  const [optimistic, setOptimistic] = useState<readonly OptimisticMessage[]>([]);
  const previous = useRef<readonly TaskUIMessage[]>([]);
  const send = useMutation(trpc.tasks.send.mutationOptions());

  const messages = useMemo(() => {
    const started = performance.now();
    const next = foldTaskEvents(log.events, visibleLiveText(log.live), { optimistic, previous: previous.current });
    onFold?.(performance.now() - started, next.length);
    previous.current = next;
    return next;
  }, [log.events, log.live, optimistic, onFold]);

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
        await send.mutateAsync({ taskId, clientMessageId, text, delivery: interrupt ? "interrupt" : "queue" });
      } catch (cause) {
        setOptimistic((list) => list.filter((m) => m.clientMessageId !== clientMessageId));
        throw new Error(errorText({ message: cause instanceof Error ? cause.message : "", data: null }) ?? t("errors.unknown"));
      }
    },
    [memberId, running, send, taskId],
  );

  const runtime = useExternalStoreRuntime<TaskUIMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isRunning: running,
    isDisabled: !canSend,
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
  const context = useMemo<TaskContextValue>(
    () => ({ store, memberName, agent: { name: agentName, model: agentModel }, approvalSummary }),
    [store, memberName, agentName, agentModel, approvalSummary],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TaskContext.Provider value={context}>
        <ThreadPrimitive.Root data-part="thread" className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
            {hasEarlier ? (
              <div className="py-2">
                <Button size="sm" variant="ghost" data-action="load-earlier" onClick={() => void loadEarlier()}>
                  {t("task.loadEarlier")}
                </Button>
              </div>
            ) : null}
            <ThreadPrimitive.Messages>{({ message }) => <MessageView id={message.id} fallbackRole={message.role} />}</ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
          {canSend ? (
            <div className="shrink-0 pt-3">
              <Composer interrupt={running && canInterrupt} onSend={sendText} />
            </div>
          ) : notDriver === undefined ? null : (
            <div className="shrink-0 pt-3 text-sm text-faint" data-part="not-driver">{notDriver}</div>
          )}
        </ThreadPrimitive.Root>
      </TaskContext.Provider>
    </AssistantRuntimeProvider>
  );
};
