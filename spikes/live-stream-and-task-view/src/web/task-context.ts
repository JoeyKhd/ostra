import { createContext, useContext, useSyncExternalStore } from "react";
import type { ApprovalId, OptionId, ToolCallId } from "../shared/ids.ts";
import type { TaskUIMessage, TaskUIPart } from "../shared/ui-types.ts";

export type ToolLikePart = Extract<TaskUIPart, { toolCallId: string }>;
export type DataLikePart = Extract<TaskUIPart, { type: `data-${string}` }>;

export type TaskPartIndex = {
  readonly tools: ReadonlyMap<ToolCallId, ToolLikePart>;
  readonly data: ReadonlyMap<string, DataLikePart>;
  readonly messages: ReadonlyMap<string, TaskUIMessage>;
};

// The index lives in a small store of its own, and every row subscribes to its own part. A row re-renders only
// when its part changed (the fold keeps the identity of what did not), so a flush of a long log costs the rows
// that changed, not every row in the thread.
export type TaskIndexStore = {
  readonly get: () => TaskPartIndex;
  // Called while rendering: swaps the index without telling anyone, so a row that mounts in this pass reads the new one.
  readonly set: (index: TaskPartIndex) => void;
  // Called once the pass is committed: tells the rows that are already mounted.
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

export type TaskActions = {
  readonly canAnswerApprovals: boolean;
  readonly answer: (approvalId: ApprovalId, optionId: OptionId) => Promise<void>;
};

export type TaskContextValue = {
  readonly store: TaskIndexStore;
  readonly actions: TaskActions;
};

// Renderers read typed parts from ostra's own store through this context, never `args` or `result`
// from assistant-ui, whose types are `any` (ADR 0036).
export const TaskContext = createContext<TaskContextValue | null>(null);

export const useTaskContext = (): TaskContextValue => {
  const value = useContext(TaskContext);
  if (value === null) throw new Error("TaskContext is missing");
  return value;
};

export const useTaskMessage = (id: string): TaskUIMessage | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().messages.get(id));
};

export const useToolPart = (id: ToolCallId | undefined): ToolLikePart | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => (id === undefined ? undefined : store.get().tools.get(id)));
};

export const useDataPart = (id: string): DataLikePart | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().data.get(id));
};

export const isToolLike = (part: TaskUIPart): part is ToolLikePart =>
  part.type === "dynamic-tool" || part.type === "tool-read" || part.type === "tool-edit" || part.type === "tool-execute";

export const isDataLike = (part: TaskUIPart): part is DataLikePart => part.type.startsWith("data-");
