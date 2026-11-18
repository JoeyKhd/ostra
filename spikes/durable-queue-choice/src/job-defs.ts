// The spike's job catalog. In ostra, each job has a fixed key shape (ADR 0037, rule 2) and carries only IDs.

import { defineJob } from "./jobs.ts";
import {
  githubEffectPayload,
  groupWorkPayload,
  scheduleFirePayload,
  taskTimeoutPayload,
  taskTransitionPayload,
} from "./payloads.ts";

// Heartbeats on every queue: a killed replica's jobs are freed after about heartbeatSeconds plus
// one supervise pass, with no executor IDs to manage. 10 s is pg-boss's minimum.
const queueOptions = {
  retryLimit: 3,
  retryDelay: 1,
  heartbeatSeconds: 10,
  expireInSeconds: 300,
} as const;

/**
 * A task transition. Enqueued in the same transaction as the change that caused it, under a fixed
 * key (`task:<TaskId>:<transition>:<seq>`).
 *
 * The queue's policy is `exclusive`: one job per key while it is queued, waiting to retry or
 * running. That is what makes "sending a job twice returns the existing one" true. A `singletonKey`
 * alone does nothing on a `standard` queue, which C1 shows with a control. Every job on an
 * exclusive queue needs a key (jobs with none collide on the empty key).
 */
export const taskTransitionJob = defineJob({
  queue: "task-transition",
  payload: taskTransitionPayload,
  queueOptions: { ...queueOptions, policy: "exclusive" },
});

/** A timer: wakes after a delay, checks the task's state and does nothing if the task has moved on. */
export const taskTimeoutJob = defineJob({
  queue: "task-timeout",
  payload: taskTimeoutPayload,
  queueOptions,
});

/** A side effect on the code host, guarded by a lookup first: find it by its branch, then create it. */
export const githubEffectJob = defineJob({
  queue: "github-effect",
  payload: githubEffectPayload,
  queueOptions,
});

/** The control: the same side effect with no lookup, to show that redelivery really happens. */
export const githubEffectNaiveJob = defineJob({
  queue: "github-effect-naive",
  payload: githubEffectPayload,
  queueOptions,
});

/** Work that must run at most 2 at a time per key, across replicas. */
export const groupWorkJob = defineJob({
  queue: "group-work",
  payload: groupWorkPayload,
  queueOptions: { ...queueOptions, retryLimit: 1 },
});

/** The job a runtime schedule fires (one schedule per connected board). */
export const scheduleFireJob = defineJob({
  queue: "schedule-fire",
  payload: scheduleFirePayload,
  queueOptions,
});

export const allJobDefinitions = [
  taskTransitionJob,
  taskTimeoutJob,
  githubEffectJob,
  githubEffectNaiveJob,
  groupWorkJob,
  scheduleFireJob,
] as const;

export const GROUP_LIMIT = 2;
