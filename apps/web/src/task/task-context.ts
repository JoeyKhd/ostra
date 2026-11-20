import { createContext, useContext, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { SubagentNode, TaskDataPart, TaskUIMessage, TaskUIPart } from "@ostra/task-view";

import type { RememberResult } from "@/components/tasks/task-changes/diff-view";

// The typed parts of the thread, in a small store of their own (ADR 0036, spike 7): every row
// subscribes to its own part, and re-renders only when that part changed. The fold keeps the
// identity of what didn't change, so a flush of a long log costs the rows that changed, not every
// row. Renderers read typed parts from here, never `args` or `result` from assistant-ui, whose
// types are `any`. Ported from spikes/live-stream-and-task-view/src/web/task-context.ts.

export type ToolLikePart = Extract<TaskUIPart, { toolCallId: string }>;

/** F-138: a subagent of a turn, by the turn's message. */
export type SubagentAt = { readonly messageId: string; readonly node: SubagentNode };

export type TaskPartIndex = {
  readonly tools: ReadonlyMap<string, ToolLikePart>;
  readonly data: ReadonlyMap<string, TaskDataPart>;
  readonly messages: ReadonlyMap<string, TaskUIMessage>;
  /** F-138: the subagent each call started, by the call's ID. */
  readonly startedBy: ReadonlyMap<string, SubagentAt>;
  /** F-138: the subagent each of its calls belongs to, by the call's ID. */
  readonly ownedBy: ReadonlyMap<string, SubagentAt>;
};

export type TaskIndexStore = {
  readonly get: () => TaskPartIndex;
  /** Swaps the index while rendering, so a row that mounts in this pass reads the new one. */
  readonly set: (index: TaskPartIndex) => void;
  /** Tells the mounted rows, once the pass is committed. */
  readonly publish: () => void;
  readonly subscribe: (listener: () => void) => () => void;
};

const emptyIndex: TaskPartIndex = { tools: new Map(), data: new Map(), messages: new Map(), startedBy: new Map(), ownedBy: new Map() };

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
  const startedBy = new Map<string, SubagentAt>();
  const ownedBy = new Map<string, SubagentAt>();
  for (const message of messages) {
    byId.set(message.id, message);
    for (const part of message.parts) {
      if (isToolLike(part)) tools.set(part.toolCallId, part);
      else if (isDataLike(part) && part.id !== undefined) data.set(part.id, part);
    }
    for (const node of message.metadata?.subagents?.nodes ?? []) {
      for (const round of node.rounds) {
        if (round.toolCallId !== null) startedBy.set(round.toolCallId, { messageId: message.id, node });
        for (const call of round.calls) ownedBy.set(call.toolCallId, { messageId: message.id, node });
      }
    }
  }
  return { tools, data, messages: byId, startedBy, ownedBy };
};

export type TaskContextValue = {
  readonly store: TaskIndexStore;
  /** Names of the organization's members, for "Approved by Alex" and the user rows. */
  readonly memberName: (memberId: string) => string;
  /** The agent's display name and its model's, for the agent's message header. */
  readonly agent: { readonly name: string; readonly model: string | null };
  /** The task's project, for the budget's held row (F-037). */
  readonly projectName?: string;
  /** What an open approval asks, in the descriptor's words (the needs-you item's summary), or `null`. */
  readonly approvalSummary: (approvalId: string) => string | null;
  /**
   * Milestone 3 (ticket 43): the answerable card of an open approval, or `null` to keep the read-only
   * note. F-138: `asker` names the subagent whose call asks (`explore · Find the version source`).
   */
  readonly approvalCard?: (approvalId: string, asker?: string) => ReactNode;
  /** The receipt of an answered or closed approval in the task page's words, or `null` for the fold's own. */
  readonly approvalReceipt?: (approvalId: string) => string | null;
  /** This member answered after someone else did: the receipt carries "Someone answered this first." */
  readonly approvalLostRace?: (approvalId: string) => boolean;
  /** The answerable form of an open question, or `null` to keep the read-only note. */
  readonly questionCard?: (questionId: string) => ReactNode;
  /** F-111: "Remember this" on an accepted `@ostra` comment, by its event's seq; absent where the page can't propose. */
  readonly rememberPrComment?: (seq: number, draft: { readonly title: string; readonly body: string }) => Promise<RememberResult>;
  /** F-138: opens the subagents window of a turn, on a subagent (`null`: the one it picks). */
  readonly openSubagents?: (messageId: string, subagentId: string | null) => void;
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

/** F-138: the subagent a call started, when it started one. */
export const useSubagentStartedBy = (toolCallId: string): SubagentAt | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().startedBy.get(toolCallId), () => store.get().startedBy.get(toolCallId));
};

/** F-138: the subagent a call belongs to, when it's a subagent's. */
export const useSubagentOwner = (toolCallId: string): SubagentAt | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().ownedBy.get(toolCallId), () => store.get().ownedBy.get(toolCallId));
};

export const useDataPart = (id: string): TaskDataPart | undefined => {
  const { store } = useTaskContext();
  return useSyncExternalStore(store.subscribe, () => store.get().data.get(id), () => store.get().data.get(id));
};
