import type { Tx } from "@ostra/db";
import type { BoxId, CommandId, LeaseEpoch, RunnerId } from "@ostra/protocol";

import type { JobPayload } from "../jobs.ts";
import type { Ports } from "../ports.ts";
import { notImplemented } from "./common.ts";
import type { UseCaseResult } from "./common.ts";

// ADR 0034, F-045: the `task.dispatch` job. It picks the runner (the member's personal runner in
// milestone 1), raises the task's lease epoch under the task row's lock, creates the box and the
// lease, writes a `dispatch` command to the outbox (with its NOTIFY), and enqueues the offer
// timeout. Written by ticket 26.

export type DispatchTaskInput = JobPayload<"task.dispatch">;

export type DispatchTaskResult = UseCaseResult<
  { readonly runnerId: RunnerId; readonly boxId: BoxId; readonly leaseEpoch: LeaseEpoch; readonly commandId: CommandId },
  /** The task moved on (stopped, or dispatched by a newer job): nothing to do. */
  | "stale"
  /** No runner can take it now; the task stays queued. */
  | "no-runner"
>;

export type DispatchTaskDeps = Pick<Ports, "jobs" | "outbox" | "notices" | "clock"> & { readonly tx: Tx };

export type DispatchTask = (deps: DispatchTaskDeps, input: DispatchTaskInput) => Promise<DispatchTaskResult>;

export const dispatchTask: DispatchTask = () => notImplemented("26");
