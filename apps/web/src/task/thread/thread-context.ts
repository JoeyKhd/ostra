import { createContext, useContext } from "react";

import type { SessionId, TaskKind } from "@ostra/protocol";
import type { ThreadContext } from "@ostra/task-view";

import type { ThreadAnswers } from "./answers";
import type { HeadCi } from "./words";

// Owner: ticket 09 (milestone 10, F-151). What every part of the compact thread reads of its task:
// its kind (a review or refine task keeps no work), the workspace's rule for relative paths and its
// MCP servers' names (ticket 03's `ThreadContext`), its project for a budget hold, and each repo's
// CI on its head for the PR card. The page gives it once, from `tasks.get`.

/** A PR as `tasks.get` lists a repo's (`repos[].pullRequests`): its state, whether it's a draft, when it opened. */
export type ThreadPr = {
  readonly number: number;
  readonly state: "open" | "merged" | "closed_unmerged";
  readonly draft: boolean;
  readonly openedAt: number;
};

/**
 * Milestone 10 (ticket 14, F-151/c6, c7): what a turn's results read of the task beyond its CI:
 * the project's AI review switch (the card's ` · then the AI review`), each repo's head and PRs
 * (a draft's and a merge's icon, and whether a push went to a PR already open), the code host's
 * verdict on a pushed head, and where a result's link goes. Without it a result line shows its
 * words alone and the card its open icon.
 */
export type ThreadResults = {
  readonly projectId: string;
  /** The project's AI review is on: the CI line ends ` · then the AI review` while CI runs. */
  readonly aiReview: boolean;
  /** A repo's head commit on `tasks.get`, or `null` before its first push. */
  readonly headOf: (repoId: string) => string | null;
  /** A repo's PRs, oldest first. */
  readonly prsOf: (repoId: string) => readonly ThreadPr[];
  /** The code host's CI on a pushed head: the repo's head's from `tasks.get`, an older head's from the log's `ci.updated`; `null` before CI says. */
  readonly ciOnHead: (repoId: string, headSha: string) => HeadCi["state"] | null;
  /** Milestone 6's review screen, for a review task's `Open the review`; `null` on any other kind. */
  readonly reviewHref: string | null;
};

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
  /** Ticket 14: what the results read beyond the CI; absent in another part's own test. */
  readonly results?: ThreadResults;
};

export const ThreadParts = createContext<ThreadPartsValue | null>(null);

export const useThreadParts = (): ThreadPartsValue => {
  const value = useContext(ThreadParts);
  if (value === null) throw new Error("ThreadParts is missing");
  return value;
};
