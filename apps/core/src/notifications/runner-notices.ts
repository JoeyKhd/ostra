import type { Logger } from "@ostra/adapter-sdk";
import { sendRunnerJoinNotice } from "@ostra/domain";
import type { RunnerJoinNoticeDeps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// `runner.join-notice` (F-091, milestone 5's ticket 12): a pool runner joined, so the organization's
// admins hear of it, and when its pool requires approval they get the open approval notice too. The
// join enqueued this in its own transaction; the work and its fan-out are the domain's. Logs carry
// IDs and counts, never the runner's name.

export const runnerJoinNoticeHandler =
  (deps: RunnerJoinNoticeDeps & { readonly logger?: Logger }): JobHandler<"runner.join-notice"> =>
  async (context) => {
    const result = await sendRunnerJoinNotice(deps, context.payload);
    context.logger.info("runner.join-notice", {
      runnerId: context.payload.runnerId,
      outcome: result.kind,
      ...(result.kind === "sent" ? { notices: result.notices.join(","), notifications: result.notifications, deliveries: result.deliveries } : {}),
    });
  };
