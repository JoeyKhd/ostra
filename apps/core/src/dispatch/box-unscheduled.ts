import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { recordBoxUnscheduledInTx } from "@ostra/domain";
import type { ChangeNotices, Clock, JobQueue } from "@ostra/domain";
import type { RunnerEventFrame } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";

// A `kubernetes` runner's word on a box the cluster never placed (ADR 0060, protocol minor 9): no
// node joined within the node wait, or the cluster had no room (an unschedulable pod with no
// scale-up, or the namespace's quota refused it). It comes in a `runner-event` frame, after the
// runner's status that offers no slot. The domain sends the task back to its pool's queue with its
// place (`recordBoxUnscheduledInTx`), not to a crash; the queue holds it until the runner reports
// room again, as it holds any task that finds none.

export type BoxUnscheduledDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
};

/** Applies a box never placed; answers `false` for any other runner event, which another reader takes. */
export const applyBoxUnscheduledRunnerEvent = async (deps: BoxUnscheduledDeps, runner: RunnerRef, frame: RunnerEventFrame): Promise<boolean> => {
  const { event } = frame;
  if (event.kind !== "box.unscheduled") {
    return false;
  }
  const result = await deps.db.$transaction((tx) =>
    recordBoxUnscheduledInTx(
      { jobs: deps.jobs, notices: deps.notices, clock: deps.clock, logger: deps.logger },
      tx,
      { organizationId: runner.organizationId, runnerId: runner.runnerId, event },
    ),
  );
  if (result.recorded) {
    deps.logger.info("box.unscheduled-requeued", { runnerId: runner.runnerId, boxId: event.boxId, taskId: result.taskId, reason: event.reason });
  } else {
    deps.logger.info("box.unscheduled-ignored", { runnerId: runner.runnerId, boxId: event.boxId, reason: event.reason, why: result.reason });
  }
  return true;
};
