"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { ApprovalId, ProjectId, QuestionId, TaskId } from "@ostra/protocol";

import type { PaletteScope } from "./registry";

// What is in scope for the palette and the shortcuts (F-081, ticket 13; command-palette.md, "On this
// page"): the task page the member is on, and the needs-you item in focus. Pages tell the shell; the
// shell's palette and key listener read it.

/** A needs-you item in focus: a row of the Needs you list, or a task page's open approval or question. */
export type ItemScope =
  | {
      readonly kind: "approval";
      readonly approvalId: ApprovalId;
      readonly taskId: TaskId;
      readonly key: string;
      /** Opens the item's deny reason (`d`). */
      readonly deny: () => void;
    }
  | {
      readonly kind: "question";
      readonly questionId: QuestionId;
      readonly taskId: TaskId;
      readonly key: string;
      /** Focuses the question's first field (`r`). */
      readonly reply: () => void;
    };

/** The task page in scope, with what its viewer may do on it (`tasks.get`'s capabilities). */
export type TaskScope = {
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  readonly key: string;
  readonly title: string;
  readonly canTakeOver: boolean;
  readonly canStop: boolean;
  readonly canReopen: boolean;
  readonly canSend: boolean;
  /** The task's open approval or question, for `a`, `d` and `r` on its page. */
  readonly item: ItemScope | null;
  /** Puts the focus in the composer (`Message the agent`). */
  readonly focusComposer: () => void;
  /** Milestone 8 (F-141): `p` switches the side pane, `f` expands the preview; a code task's page only. */
  readonly preview?: { readonly toggle: () => void; readonly expand: () => void };
};

export type ActionScope = {
  readonly task: TaskScope | null;
  /** The focused list row's item, else the task page's open item. */
  readonly item: ItemScope | null;
  readonly scopes: readonly PaletteScope[];
};

type ScopeSetters = {
  readonly setTask: (task: TaskScope | null) => void;
  readonly setFocusedItem: (item: ItemScope | null) => void;
};

const ScopeContext = createContext<ActionScope>({ task: null, item: null, scopes: ["global"] });
const SettersContext = createContext<ScopeSetters>({ setTask: () => undefined, setFocusedItem: () => undefined });

export const scopeOf = (task: TaskScope | null, focused: ItemScope | null): ActionScope => {
  const item = focused ?? task?.item ?? null;
  return {
    task,
    item,
    scopes: ["global", ...(item === null ? [] : (["needs-you-item"] as const)), ...(task === null ? [] : (["task"] as const))],
  };
};

export const ActionScopeProvider = ({ children }: { readonly children: ReactNode }) => {
  const [task, setTask] = useState<TaskScope | null>(null);
  const [focused, setFocusedItem] = useState<ItemScope | null>(null);
  const scope = useMemo(() => scopeOf(task, focused), [task, focused]);
  const setters = useMemo(() => ({ setTask, setFocusedItem }), []);
  return (
    <SettersContext.Provider value={setters}>
      <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>
    </SettersContext.Provider>
  );
};

/** What is in scope now. */
export const useActionScope = (): ActionScope => useContext(ScopeContext);

/** A task page puts itself in scope while it's open, and takes itself out when it leaves. */
export const useProvideTaskScope = (task: TaskScope | null): void => {
  const { setTask } = useContext(SettersContext);
  const latest = useRef(task);
  latest.current = task;
  // The scope's callbacks change identity each render; the facts decide when it's set again.
  const facts = task === null ? null : JSON.stringify({ ...task, item: task.item === null ? null : { ...task.item } });
  useEffect(() => {
    setTask(latest.current);
  }, [facts, setTask]);
  useEffect(() => () => { setTask(null); }, [setTask]);
};

/** A list row's focus handlers: the row's item is in scope while it holds the focus. */
export const useFocusedItem = (): { readonly focus: (item: ItemScope | null) => void; readonly blur: () => void } => {
  const { setFocusedItem } = useContext(SettersContext);
  return useMemo(() => ({ focus: setFocusedItem, blur: () => { setFocusedItem(null); } }), [setFocusedItem]);
};
