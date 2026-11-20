import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { recordBoxWaitInTx } from "@ostra/domain";
import type { Clock } from "@ostra/domain";
import type { RunnerEventFrame } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";

// A `kubernetes` runner's word on a box it accepted (milestone 5, ticket 20, F-093): `box.waiting`
// while its pod waits for a node or its image, `box.scheduled` once it's placed. Both come in a
// `runner-event` frame, outside the task's session, since the box's sidecar holds the session once
// it runs. The domain keeps the wait on the box's row and the task's timeline (`recordBoxWaitInTx`).

export type BoxWaitDeps = { readonly db: Db; readonly clock: Clock; readonly logger: Logger };

/** Applies a box's wait; answers `false` for any other runner event, which another reader takes. */
export const applyBoxRunnerEvent = async (deps: BoxWaitDeps, runner: RunnerRef, frame: RunnerEventFrame): Promise<boolean> => {
  const { event } = frame;
  if (event.kind !== "box.waiting" && event.kind !== "box.scheduled") {
    return false;
  }
  const result = await deps.db.$transaction((tx) => recordBoxWaitInTx(tx, deps.clock, { organizationId: runner.organizationId, runnerId: runner.runnerId, event }));
  if (result.recorded) {
    deps.logger.info("box.wait-recorded", { runnerId: runner.runnerId, boxId: event.boxId, kind: event.kind });
  } else {
    deps.logger.info("box.wait-ignored", { runnerId: runner.runnerId, boxId: event.boxId, kind: event.kind, reason: result.reason });
  }
  return true;
};
