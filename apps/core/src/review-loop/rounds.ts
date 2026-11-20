import { roundKindToDb, startRound } from "@ostra/domain";
import type { StartRoundDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// A fixing round's job (F-035, F-101, ADR 0041, ADR 0058; milestone 6's ticket 18): `round.start`,
// keyed by the task, the kind and the cause (the head for CI, the review run for findings). The
// domain's `startRound` runs it in the task's lock: the caps since a person last acted, the budget
// gate as an automatic round, the task's spend cap, then the turn, on the warm box when its runner
// speaks minor 5 and the session is idle, else on a fresh box. The prompt's text is never logged.

export const roundStartHandler =
  (deps: Omit<StartRoundDeps, "logger">): JobHandler<"round.start"> =>
  async (context) => {
    const { taskId, kind, causeRef } = context.payload;
    const result = await startRound({ ...deps, logger: context.logger }, { organizationId: context.payload.organizationId, taskId, kind: roundKindToDb[kind], causeRef });
    if (!result.ok) {
      context.logger.info("round.start-skipped", { taskId, kind, error: result.error });
      return;
    }
    context.logger.info("round.start-done", { taskId, kind, causeRef, outcome: result.outcome, held: result.held });
  };
