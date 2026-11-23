import { createContext, useContext } from "react";

import type { SessionId, TaskKind } from "@ostra/protocol";
import type { ThreadContext } from "@ostra/task-view";

import type { ThreadAnswers } from "./answers";
import type { HeadCi } from "./words";

// Owner: ticket 09 (milestone 10, F-151). What every part of the compact thread reads of its task:
// its kind (a review or refine task keeps no work), the workspace's rule for relative paths and its
// MCP servers' names (ticket 03's `ThreadContext`), its project for a budget hold, and each repo's
// CI on its head for the PR card. The page gives it once, from `tasks.get`.

export type ThreadPartsValue = {
  readonly taskKind: TaskKind;
  /** `turnItemsOf`'s and `liveStepOf`'s context: the task, its checkout folders and its MCP servers. */
  readonly workspace: ThreadContext;
  /** The task's project, for a budget hold's notice. */
  readonly project: string;
  /** The task's spend cap in micro-USD, for the cap's notice; `null` without one. */
  readonly capMicroUsd: number | null;
  /** The code host's CI on a repo's head (`tasks.get`'s `repos[].ci`); `null` without a PR. */
  readonly ciOf: (repoId: string) => HeadCi | null;
  /** Ticket 12: what members answered, read from the log (`answers.ts`): the plan's receipts and markers, late answers. */
  readonly answers?: ThreadAnswers;
  /** Ticket 12: the runner a session came back on, for its divider (the task's runner now, for its last session). */
  readonly runnerOf?: (sessionId: SessionId | undefined) => string | null;
  /** Ticket 12: the task's title, for "What the agent got" (a ticket task's title is its ticket's). */
  readonly taskTitle?: string;
};

export const ThreadParts = createContext<ThreadPartsValue | null>(null);

export const useThreadParts = (): ThreadPartsValue => {
  const value = useContext(ThreadParts);
  if (value === null) throw new Error("ThreadParts is missing");
  return value;
};
