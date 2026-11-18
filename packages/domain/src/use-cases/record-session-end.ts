import type { Tx } from "@ostra/db";

import type { JobPayload } from "../jobs.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// F-030, F-065: the `task.session-ended` job, reacting to a stored `session.ended`. The session ends
// with or without changes, its box is released, and its lease ends. With changes: each task repo
// that is ahead records its branch, and a `task.open-pull-requests` job follows; the task moves to
// in review once its PRs are open. Without: the task goes to needs you with the agent's last message
// as the summary, and no PR is opened. Written by ticket 27.

export type RecordSessionEndInput = JobPayload<"task.session-ended">;

export type RecordSessionEndResult = UseCaseResult<
  { readonly outcome: "with-changes" | "without-changes" },
  /** The event isn't the session's end, or the task moved on. */
  "stale" | "not-found"
>;

export type RecordSessionEndDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & { readonly tx: Tx };

export type RecordSessionEnd = (deps: RecordSessionEndDeps, input: RecordSessionEndInput) => Promise<RecordSessionEndResult>;

export const recordSessionEnd: RecordSessionEnd = () => notImplemented("27");
