import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { deriveTaskState, foldTaskEvents, type OptimisticMessage } from "../shared/fold.ts";
import { ApprovalId, ClientMessageId, OptionId, ToolCallId, type TaskId } from "../shared/ids.ts";
import type { TaskUIMessage } from "../shared/ui-types.ts";
import { api } from "./api.ts";
import { toThreadMessageLike } from "./convert.ts";
import { latencies } from "./probe.ts";
import { AssistantText, DataRow, Reasoning, SafeLink, ToolRow } from "./renderers.tsx";
import { createTaskIndexStore, isDataLike, isToolLike, TaskContext, useTaskMessage, type DataLikePart, type TaskContextValue, type ToolLikePart } from "./task-context.ts";
import { createTaskStream, type TaskStream } from "./task-stream.ts";

type Marks = { firstRenderAt: number | null; renderedEvents: number; renderedMessages: number; fetchedAt: number | null; foldMs: number };
const marks: Marks = { firstRenderAt: null, renderedEvents: 0, renderedMessages: 0, fetchedAt: null, foldMs: 0 };

const publishDiagnostics = (stream: TaskStream): void => {
  Object.defineProperty(window, "__ostra", {
    configurable: true,
    value: {
      counters: () => ({ ...stream.counters }),
      seenSeqs: () => [...stream.seenSeqs],
      liveLog: () => [...stream.liveLog],
      marks: () => ({ ...marks, ...stream.timing }),
      status: () => stream.getSnapshot().status,
      lastSeq: () => stream.getSnapshot().events.at(-1)?.seq ?? 0,
      eventCount: () => stream.getSnapshot().events.length,
      // emit-to-DOM latencies, recorded only when the page was opened with ?probe=latency
      latencies: () => latencies(),
    },
  });
};

const dataImage = (url: string): string | null => (url.startsWith("data:image/") ? url : null);

const MessageView = memo(({ message }: { message: { id: string; role: "user" | "assistant" | "system" } }) => {
  const own = useTaskMessage(message.id);
  const meta = own?.metadata;
  const role = own?.role ?? message.role;
  return (
    <MessagePrimitive.Root
      className={`message ${role}`}
      data-role={role}
      data-message-id={message.id}
      data-turn-state={meta?.turnState}
      data-stop-reason={meta?.stopReason}
      data-delivery={meta?.author?.delivery}
      data-author={meta?.author?.memberId}
      data-optimistic={meta?.optimistic === true ? "true" : undefined}
    >
      <MessagePrimitive.Parts>
        {({ part }) => {
          switch (part.type) {
            case "text":
              return role === "user" ? (
                <div data-part="user-text" className="user-text">
                  {part.text}
                </div>
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
                <div className="line" data-part="source">
                  <SafeLink href={part.url}>{part.title ?? part.url}</SafeLink>
                </div>
              );
            case "image": {
              const src = dataImage(part.image);
              return src === null ? (
                <div className="line" data-part="image-blocked">
                  Image not shown (remote)
                </div>
              ) : (
                <img data-part="image" src={src} alt="" />
              );
            }
            case "file":
            case "audio":
            case "generative-ui":
              return null;
            default:
              return part satisfies never;
          }
        }}
      </MessagePrimitive.Parts>
    </MessagePrimitive.Root>
  );
});

const Composer = ({ running, onInterrupt, onInterruptAndSend }: { running: boolean; onInterrupt: () => void; onInterruptAndSend: (text: string) => Promise<void> }) => {
  const text = useAuiState((s) => s.composer.text);
  const aui = useAui();
  return (
    <ComposerPrimitive.Root className="composer" data-part="composer">
      <ComposerPrimitive.Input className="composer-input" data-part="composer-input" placeholder="Message the agent" rows={2} />
      <div className="composer-actions">
        {running ? (
          <button type="button" data-action="interrupt" onClick={onInterrupt}>
            Interrupt
          </button>
        ) : null}
        <button
          type="button"
          data-action="interrupt-and-send"
          disabled={text.trim().length === 0}
          onClick={() => {
            void onInterruptAndSend(text).then(() => {
              aui.composer.setText("");
            });
          }}
        >
          Interrupt and send
        </button>
        <ComposerPrimitive.Send data-action="send">Send</ComposerPrimitive.Send>
      </div>
      <p className="hint">Send queues. Interrupt and send stops the current turn.</p>
    </ComposerPrimitive.Root>
  );
};

export const TaskPage = ({ taskId, turns }: { taskId: TaskId; turns: string }) => {
  const stream = useMemo(() => createTaskStream(taskId, turns), [taskId, turns]);
  const [error, setError] = useState<string | null>(null);
  const snap = useSyncExternalStore(stream.subscribe, stream.getSnapshot);
  const [optimistic, setOptimistic] = useState<readonly OptimisticMessage[]>([]);
  const previous = useRef<readonly TaskUIMessage[]>([]);

  useEffect(() => {
    publishDiagnostics(stream);
    stream.start().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "failed to load");
    });
    return () => {
      stream.stop();
    };
  }, [stream]);

  const messages = useMemo(() => {
    const started = performance.now();
    const next = foldTaskEvents(snap.events, snap.live, { optimistic, previous: previous.current });
    marks.foldMs = performance.now() - started;
    previous.current = next;
    return next;
  }, [snap.events, snap.live, optimistic]);

  const view = useMemo(() => deriveTaskState(snap.events, snap.info?.task.driverMemberId ?? null), [snap.events, snap.info]);

  const me = snap.info?.me ?? null;
  const isMember = me?.role === "member";
  const canSend = isMember && view.driverMemberId === me.memberId;
  const canAnswer = isMember;

  const sendText = useCallback(
    async (text: string, interruptFirst: boolean): Promise<void> => {
      if (me === null) return;
      const clientMessageId = ClientMessageId.parse(crypto.randomUUID());
      const entry: OptimisticMessage = { clientMessageId, memberId: me.memberId, text, delivery: interruptFirst ? "after-interrupt" : view.turnRunning ? "queued" : "immediate" };
      setOptimistic((list) => [...list, entry]);
      try {
        await api.send(taskId, text, clientMessageId, interruptFirst);
      } catch (cause) {
        setOptimistic((list) => list.filter((m) => m.clientMessageId !== clientMessageId));
        throw cause;
      }
    },
    [me, taskId, view.turnRunning],
  );

  useEffect(() => {
    // forget optimistic sends once the committed message is in the log
    const committed = new Set<string>();
    for (const { event } of snap.events) if (event.kind === "user.message") committed.add(event.clientMessageId);
    setOptimistic((list) => (list.some((m) => committed.has(m.clientMessageId)) ? list.filter((m) => !committed.has(m.clientMessageId)) : list));
  }, [snap.events]);

  const answer = useCallback((approvalId: ApprovalId, optionId: OptionId) => api.answer(taskId, approvalId, optionId).then(() => undefined), [taskId]);

  const runtime = useExternalStoreRuntime<TaskUIMessage>({
    messages,
    convertMessage: toThreadMessageLike,
    isRunning: view.turnRunning,
    isDisabled: !canSend,
    hasEarlier: snap.hasEarlier,
    onLoadEarlier: () => stream.loadEarlier(),
    onNew: async (message) => {
      const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      if (text.trim().length > 0) await sendText(text, false);
    },
    onCancel: async () => {
      await api.interrupt(taskId);
    },
    // A watcher who may not answer gets no handler, so the approval renders without controls.
    ...(canAnswer
      ? {
          onRespondToToolApproval: async (response: { approvalId: string; optionId?: string | undefined }) => {
            // assistant-ui hands back plain strings: they are branded here, at the boundary
            await answer(ApprovalId.parse(response.approvalId), OptionId.parse(response.optionId));
          },
        }
      : {}),
  });

  // The index of typed parts lives in a store the rows subscribe to, so the context value never changes and a
  // flush re-renders only the rows whose part changed.
  const store = useMemo(() => createTaskIndexStore(), []);
  const index = useMemo(() => {
    const tools = new Map<ToolCallId, ToolLikePart>();
    const data = new Map<string, DataLikePart>();
    const byId = new Map<string, TaskUIMessage>();
    for (const message of messages) {
      byId.set(message.id, message);
      for (const part of message.parts) {
        if (isToolLike(part)) {
          const id = ToolCallId.safeParse(part.toolCallId);
          if (id.success) tools.set(id.data, part);
        }
        else if (isDataLike(part) && part.id !== undefined) data.set(part.id, part);
      }
    }
    const built = { tools, data, messages: byId };
    // rows that mount in this pass read the new index; the ones already mounted are told after the commit
    store.set(built);
    return built;
  }, [messages, store]);
  useLayoutEffect(() => {
    store.publish();
  }, [index, store]);
  const context = useMemo<TaskContextValue>(() => ({ store, actions: { canAnswerApprovals: canAnswer, answer } }), [store, canAnswer, answer]);

  // The page's first full render, for the "5,000 events render in under 1.5 s" check.
  useEffect(() => {
    if (marks.firstRenderAt !== null || snap.info === null || messages.length === 0) return;
    const expected = messages.length;
    const expectedTools = messages.reduce((n, m) => n + m.parts.filter(isToolLike).length, 0);
    const check = (): void => {
      const rendered = document.querySelectorAll("[data-message-id]").length;
      // every message is in the DOM, and every tool row in them
      if (rendered >= expected && document.querySelectorAll("[data-part=tool]").length >= expectedTools) {
        marks.firstRenderAt = performance.now();
        marks.renderedEvents = snap.events.length;
        marks.renderedMessages = rendered;
      } else {
        requestAnimationFrame(check);
      }
    };
    requestAnimationFrame(check);
  }, [messages, snap.info, snap.events.length]);

  const [takeOverError, setTakeOverError] = useState<string | null>(null);
  const takeOver = (): void => {
    setTakeOverError(null);
    void api
      .task(taskId)
      .then((info) => api.takeOver(taskId, info.task.driverVersion))
      .catch((cause: unknown) => {
        setTakeOverError(cause instanceof Error ? cause.message : "take over failed");
      });
  };

  if (error !== null) {
    return (
      <div className="page" role="alert" data-part="page-error">
        {error}
      </div>
    );
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TaskContext.Provider value={context}>
        <div className="page" data-part="page" data-status={snap.status}>
          <header className="bar" data-part="header">
            <span className="title">{taskId}</span>
            <span className="muted" data-part="status">
              {view.turnRunning ? "running" : "idle"} · {snap.status}
            </span>
            <span className="muted" data-part="me">
              {me === null ? "" : `${me.memberId} (${me.role})`}
            </span>
          </header>
          <ThreadPrimitive.Root className="thread" data-part="thread">
            <ThreadPrimitive.Viewport className="viewport">
              {snap.hasEarlier ? (
                <ThreadPrimitive.LoadEarlier className="load-earlier" data-action="load-earlier">
                  Load earlier turns
                </ThreadPrimitive.LoadEarlier>
              ) : null}
              <ThreadPrimitive.Messages>{({ message }) => <MessageView message={message} />}</ThreadPrimitive.Messages>
            </ThreadPrimitive.Viewport>
          </ThreadPrimitive.Root>
          {canSend ? (
            <Composer
              running={view.turnRunning}
              onInterrupt={() => {
                void api.interrupt(taskId);
              }}
              onInterruptAndSend={(text) => sendText(text, true)}
            />
          ) : (
            <div className="watcher-bar" data-part="watcher-bar">
              <span>
                {view.driverMemberId === null ? "Nobody is driving" : `${view.driverMemberId} is driving`}
                {isMember ? " · " : " · read-only"}
              </span>
              {isMember ? (
                <button type="button" data-action="take-over" onClick={takeOver}>
                  Take over
                </button>
              ) : null}
              {takeOverError === null ? null : (
                <span className="error" role="alert">
                  {takeOverError}
                </span>
              )}
            </div>
          )}
        </div>
      </TaskContext.Provider>
    </AssistantRuntimeProvider>
  );
};
