import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { recordBoxLostInTx } from "@ostra/domain";
import type { Clock, ChangeNotices, JobQueue, SessionTimers } from "@ostra/domain";
import type { RunnerEventFrame } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";

// A pool runner's word on a box that went away under its task (F-047, protocol minor 8): a
// `docker` box whose sidecar exited with an error or vanished, a `kubernetes` pod deleted or
// failed. It comes in a `runner-event` frame, outside the task's session, since the box's sidecar
// held the session and is gone with it. The domain records the session's crash with the cause
// `box_lost` and moves the rows as the runner's own `session.crashed` does (`recordBoxLostInTx`).

export type BoxLostDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The session's timers, which the crash ends (ticket 19). */
  readonly timers?: SessionTimers;
};

/** Applies a lost box; answers `false` for any other runner event, which another reader takes. */
export const applyBoxLostRunnerEvent = async (deps: BoxLostDeps, runner: RunnerRef, frame: RunnerEventFrame): Promise<boolean> => {
  const { event } = frame;
  if (event.kind !== "box.lost") {
    return false;
  }
  const result = await deps.db.$transaction((tx) =>
    recordBoxLostInTx(
      { tx, jobs: deps.jobs, notices: deps.notices, clock: deps.clock, logger: deps.logger, ...(deps.timers === undefined ? {} : { timers: deps.timers }) },
      { organizationId: runner.organizationId, runnerId: runner.runnerId, event },
    ),
  );
  if (result.recorded) {
    deps.logger.info("box.lost-recorded", { runnerId: runner.runnerId, boxId: event.boxId, taskId: result.taskId, sessionId: result.sessionId, exitCode: event.exitCode });
  } else {
    deps.logger.info("box.lost-ignored", { runnerId: runner.runnerId, boxId: event.boxId, exitCode: event.exitCode, reason: result.reason });
  }
  return true;
};
