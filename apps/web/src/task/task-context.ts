import { createContext, useContext, useSyncExternalStore } from "react";

import type { TaskDataPart, TaskUIMessage, TaskUIPart } from "@ostra/task-view";

// The typed parts of the thread, in a small store of their own (ADR 0036, spike 7): every row
// subscribes to its own part, and re-renders only when that part changed. The fold keeps the
// identity of what didn't change, so a flush of a long log costs the rows that changed, not every
// row. Renderers read typed parts from here, never `args` or `result` from assistant-ui, whose
// types are `any`. Ported from spikes/live-stream-and-task-view/src/web/task-context.ts.

export type ToolLikePart = Extract<TaskUIPart, { toolCallId: string }>;

export type TaskPartIndex = {
  readonly tools: ReadonlyMap<string, ToolLikePart>;
  readonly data: ReadonlyMap<string, TaskDataPart>;
  readonly messages: ReadonlyMap<string, TaskUIMessage>;
};

export type TaskIndexStore = {
  readonly get: () => TaskPartIndex;
  /** Swaps the index while rendering, so a row that mounts in this pass reads the new one. */
  readonly set: (index: TaskPartIndex) => void;
  /** Tells the mounted rows, once the pass is committed. */
  readonly publish: () => void;
  readonly subscribe: (listener: () => void) => () => void;
};

const emptyIndex: TaskPartIndex = { tools: new Map(), data: new Map(), messages: new Map() };

export const createTaskIndexStore = (): TaskIndexStore => {
  let index = emptyIndex;
  const listeners = new Set<() => void>();
  return {
    get: () => index,
    set: (next) => {
      index = next;
    },
    publish: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export const isToolLike = (part: TaskUIPart): part is ToolLikePart =>
  part.type === "dynamic-tool" || part.type === "tool-read" || part.type === "tool-edit" || part.type === "tool-execute";

export const isDataLike = (part: TaskUIPart): part is TaskDataPart => part.type.startsWith("data-");

/** Builds the index of a fold's result. */
export const indexMessages = (messages: readonly TaskUIMessage[]): TaskPartIndex => {
  const tools = new Map<string, ToolLikePart>();
  const data = new Map<string, TaskDataPart>();
  const byId = new Map<string, TaskUIMessage>();
  for (const message of messages) {
    byId.set(message.id, message);
    for (const part of message.parts) {
      if (isToolLike(part)) tools.set(part.toolCallId, part);
      else if (isDataLike(part) && part.id !== undefined) data.set(part.id, part);
    }
  }
  return { tools, data, messages: byId };
};

export type TaskContextValue = {
  readonly store: TaskIndexStore;
  /** Names of the organization's members, for "Approved by Alex" and the user rows. */
  readonly memberName: (memberId: string) => string;
  /** The agent's display name and its model's, for the agent's message header. */
  readonly agent: { readonly name: string; readonly model: string | null };
  /** What an open approval asks, in the descriptor's words (the needs-you item's summary), or `null`. */
  readonly approvalSummary: (approvalId: string) => string | null;
};

export const TaskContext = createContext<TaskContextValue | null>(null);

export const useTaskContext = (): TaskContextValue => {
  const value = useContext(TaskContext);
  if (value === null) throw new Error("TaskContext is missing");
  return value;
};

export const useTaskMessage = (id: string): TaskUIMessage | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().messages.get(id), () => store.get().messages.get(id));
};

export const useToolPart = (id: string): ToolLikePart | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().tools.get(id), () => store.get().tools.get(id));
};

export const useDataPart = (id: string): TaskDataPart | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().data.get(id), () => store.get().data.get(id));
};
