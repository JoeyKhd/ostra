import { randomUUID } from "node:crypto";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { SeededMember } from "@ostra/db/testing";
import { dispatchTask, postgresChangeNotices, postgresCommandOutbox, systemClock } from "@ostra/domain";
import type { JobName, JobPayload } from "@ostra/domain";
import { jobIdSchema } from "@ostra/jobs";
import type { JobContext, Jobs } from "@ostra/jobs";
import { gitShaSchema } from "@ostra/protocol";
import type { DownFrame, EventsFrame, GitSha, TaskEvent } from "@ostra/protocol";

import { applyOfferResultsInTx } from "../dispatch/dispatcher.ts";
import type { RunnerRef } from "../gateway/context.ts";
import type { Ingest } from "../ingest/ingest.ts";
import { dispatchPayload, seedQueuedTask } from "./world.ts";
import type { QueuedTask, World } from "./world.ts";

// A task driven turn by turn through core's real ingest, for the milestone 2 tests (tickets 17 to
// 21): dispatched, accepted, then events sent as a minor-1 runner sends them.

export type DrivenTask = QueuedTask & {
  /** The next number in the session; `epoch` and `session` say where events go. */
  readonly next: () => number;
  readonly runner: RunnerRef;
  /** Sends events in one frame and returns the replies; every one must be an ack without `resendFrom`. */
  readonly send: (...events: TaskEvent[]) => Promise<readonly DownFrame[]>;
};

/** A job's context, as the queue hands it to a handler. */
export const jobContext = <N extends JobName>(job: N, payload: JobPayload<N>, logger: Logger): JobContext<N> => ({
  job,
  jobId: jobIdSchema.parse(randomUUID()),
  key: null,
  retryCount: 0,
  payload,
  logger,
});

/** A commit's SHA from a short word, for readable tests. */
export const sha = (word: string): GitSha => gitShaSchema.parse(Buffer.from(word).toString("hex").padEnd(40, "0").slice(0, 40));

/** A queued task, dispatched to `runner` and accepted: it's preparing, and its session waits for its first turn. */
export const acceptedTask = async (
  deps: { readonly db: Db; readonly jobs: Jobs; readonly ingest: Ingest; readonly logger: Logger },
  world: World,
  creator: SeededMember,
  runner: RunnerRef,
  queued?: QueuedTask,
): Promise<DrivenTask> => {
  const task = queued ?? (await seedQueuedTask(deps.db, world, creator, runner.runnerId));
  const row = await deps.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  const epoch = row.leaseEpoch + 1;
  const offered = await deps.db.$transaction((tx) =>
    dispatchTask({ tx, jobs: deps.jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock }, dispatchPayload(task, epoch)),
  );
  if (!offered.ok) {
    throw new Error(`dispatch failed: ${offered.message}`);
  }
  const command = await deps.db.command.findUniqueOrThrow({ where: { id: offered.commandId } });
  await deps.db.$transaction((tx) =>
    applyOfferResultsInTx({ jobs: deps.jobs, notices: postgresChangeNotices, clock: systemClock, logger: deps.logger }, tx, runner, [
      { commandId: offered.commandId, seq: command.seq, kind: "dispatch", body: command.body, taskId: task.taskId, result: "accepted", reason: null },
    ]),
  );
  return drive(deps.ingest, task, runner, epoch);
};

/** Sends events for `task`'s session at `epoch`, numbering them from 1. */
export const drive = (ingest: Ingest, task: QueuedTask, runner: RunnerRef, epoch: number, from = 0): DrivenTask => {
  let seq = from;
  const next = (): number => {
    seq += 1;
    return seq;
  };
  const send = async (...events: TaskEvent[]): Promise<readonly DownFrame[]> => {
    const frame: EventsFrame = {
      type: "events",
      events: events.map((event) => ({ sessionId: task.sessionId, sessionSeq: next(), leaseEpoch: epoch, at: Date.now(), event })),
    };
    const replies = await ingest(runner, frame);
    for (const reply of replies) {
      if (reply.type !== "ack" || reply.resendFrom !== undefined) {
        throw new Error(`the batch wasn't saved: ${JSON.stringify(reply)}`);
      }
    }
    return replies;
  };
  return { ...task, next, runner, send };
};
