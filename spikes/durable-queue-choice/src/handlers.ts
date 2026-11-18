// What a replica does with each job. Every handler checks the state of its own tables before it
// acts (ADR 0037, rule 1) and writes a `job_run` row the harness reads back. Rows carry IDs and
// short phase names, never content.

import { setTimeout as delay } from "node:timers/promises";
import { createPull, pullExists } from "./code-host.ts";
import type { CreatePullOptions } from "./code-host.ts";
import type { PrismaClient } from "./generated/prisma/client.ts";
import type { JobId } from "./ids.ts";
import {
  githubEffectJob,
  githubEffectNaiveJob,
  groupWorkJob,
  scheduleFireJob,
  taskTimeoutJob,
  taskTransitionJob,
} from "./job-defs.ts";
import type { Jobs } from "./jobs.ts";
import type { ReplicaConfig } from "./messages.ts";

export type HandlerDeps = {
  readonly prisma: PrismaClient;
  readonly jobs: Jobs;
  readonly config: ReplicaConfig;
};

/** The harness's hold knobs apply to the first attempt only: a retried attempt must run straight through. */
const holdsFor = (retryCount: number, payload: CreatePullOptions): CreatePullOptions =>
  retryCount === 0
    ? { beforeCountHoldMs: payload.beforeCountHoldMs, afterCountHoldMs: payload.afterCountHoldMs }
    : { beforeCountHoldMs: 0, afterCountHoldMs: 0 };

export const registerWorkers = async (deps: HandlerDeps): Promise<void> => {
  const { prisma, jobs, config } = deps;
  const replicaId = config.replicaId;

  const recordRun = async (queue: string, jobId: JobId, attempt: number, phase: string, detail = ""): Promise<void> => {
    await prisma.jobRun.create({ data: { queue, jobId, attempt, replicaId, phase, detail } });
  };

  const base = {
    localConcurrency: config.localConcurrency,
    pollingIntervalSeconds: config.pollingIntervalSeconds,
  };

  for (const name of config.workers) {
    switch (name) {
      case "effect": {
        // Idempotent toward the code host (F-046): ask first whether the effect already happened,
        // by the marker the real adapter will use (the branch), then create it if not.
        await jobs.work(githubEffectJob, base, async ({ job, jobId, payload }) => {
          await recordRun(githubEffectJob.queue, jobId, job.retryCount, "start");
          const existing = await pullExists(config.fakeGithubUrl, payload.key);
          if (existing) {
            await recordRun(githubEffectJob.queue, jobId, job.retryCount, "skip-existing");
          } else {
            // A 422 here means the lookup missed a pull request that was created since (a race).
            const outcome = await createPull(config.fakeGithubUrl, payload.key, holdsFor(job.retryCount, payload));
            await recordRun(githubEffectJob.queue, jobId, job.retryCount, outcome === "created" ? "created" : "exists-on-create");
          }
          // The long part of the job. The harness kills a replica in here, after the effect landed.
          if (job.retryCount === 0 && payload.holdMs > 0) {
            await delay(payload.holdMs, undefined, { signal: job.signal });
          }
          await recordRun(githubEffectJob.queue, jobId, job.retryCount, "done");
        });
        break;
      }
      case "effectNaive": {
        // The control: no check. A redelivered job repeats the call.
        await jobs.work(githubEffectNaiveJob, base, async ({ job, jobId, payload }) => {
          await recordRun(githubEffectNaiveJob.queue, jobId, job.retryCount, "start");
          await createPull(config.fakeGithubUrl, payload.key, holdsFor(job.retryCount, payload));
          await recordRun(githubEffectNaiveJob.queue, jobId, job.retryCount, "created");
          if (job.retryCount === 0 && payload.holdMs > 0) {
            await delay(payload.holdMs, undefined, { signal: job.signal });
          }
          await recordRun(githubEffectNaiveJob.queue, jobId, job.retryCount, "done");
        });
        break;
      }
      case "group": {
        await jobs.work(
          groupWorkJob,
          { ...base, groupConcurrency: config.groupConcurrency },
          async ({ job, jobId, payload }) => {
            await prisma.groupEvent.create({
              data: { groupKey: payload.key, jobId, kind: "start", replicaId },
            });
            await delay(payload.workMs, undefined, { signal: job.signal });
            await prisma.groupEvent.create({
              data: { groupKey: payload.key, jobId, kind: "end", replicaId },
            });
          },
        );
        break;
      }
      case "scheduleFire": {
        await jobs.work(scheduleFireJob, base, async ({ job, jobId, payload }) => {
          await prisma.scheduleFire.create({
            data: {
              scheduleKey: payload.board,
              variant: payload.variant,
              jobId,
              replicaId,
              jobCreated: job.createdOn,
            },
          });
        });
        break;
      }
      case "transition": {
        await jobs.work(taskTransitionJob, base, async ({ job, jobId, payload }) => {
          // Check the task's state again before acting.
          const moved = await prisma.task.updateMany({
            where: { id: payload.taskId, state: "queued" },
            data: { state: "prepared" },
          });
          await recordRun(taskTransitionJob.queue, jobId, job.retryCount, "done", moved.count === 1 ? "transitioned" : "state-moved-on");
        });
        break;
      }
      case "timeout": {
        await jobs.work(taskTimeoutJob, base, async ({ job, jobId, payload }) => {
          // A timer wakes, checks the state, and does nothing if the task has moved on.
          const task = await prisma.task.findUnique({ where: { id: payload.taskId } });
          if (task !== null && task.state === payload.expectState) {
            await prisma.task.update({ where: { id: payload.taskId }, data: { state: "timed-out" } });
            await recordRun(taskTimeoutJob.queue, jobId, job.retryCount, "done", "fired");
          } else {
            await recordRun(taskTimeoutJob.queue, jobId, job.retryCount, "done", "noop-task-moved-on");
          }
        });
        break;
      }
      default: {
        name satisfies never;
        throw new Error("unknown worker");
      }
    }
  }
};
