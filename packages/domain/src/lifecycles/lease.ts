import type { LeaseEpoch } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// A lease's lifecycle (domain-model.md, "The task"; ADR 0034, F-045): the server's grant that lets
// one box work on the task. Each dispatch raises the task's epoch; a write from an older epoch is
// refused, and so is one after the lease ended.

export type LeaseEndReason = "released" | "grace-expired" | "superseded" | "rejected" | "offer-timeout";

export type LeaseLifecycle =
  | { readonly state: "active"; readonly epoch: LeaseEpoch }
  | { readonly state: "ended"; readonly epoch: LeaseEpoch; readonly reason: LeaseEndReason };

export type LeaseInput = { readonly type: "end"; readonly reason: LeaseEndReason };

export const transitionLease = (lease: LeaseLifecycle, input: LeaseInput): Transition<LeaseLifecycle> =>
  lease.state === "active" ? moveTo({ state: "ended", epoch: lease.epoch, reason: input.reason }) : refuse(input, lease.state);

/** The epoch the next dispatch gets: one more than the task's current one (which starts at 0). */
export const nextEpoch = (current: number): LeaseEpoch => current + 1;

/** Whether a write carrying `epoch` is accepted for a task whose lease is `lease`. */
export const acceptsWrite = (lease: LeaseLifecycle | null, epoch: LeaseEpoch): boolean =>
  lease !== null && lease.state === "active" && lease.epoch === epoch;
