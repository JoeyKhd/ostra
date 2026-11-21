import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { sweepPreviewCodes, sweepPreviewViews } from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, PreviewSettings } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";

// The previews' sweeps (milestone 8, ticket 19, ADR 0068): `preview.views-sweep` once a minute
// closes the views nobody watches (no heartbeat for 2 minutes), those whose box or link ended, and
// every view of a box past the warm cap, so the box idles out (Q299); `preview.codes-sweep` once a
// day removes the one-time codes and CLI tickets used or expired. Every time comes from the `Clock`.

export type PreviewSweepDeps = {
  readonly db: Db;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: Pick<PreviewSettings, "warmMinutes">;
};

/** Once a minute, however many replicas run. */
export const VIEWS_SWEEP_CRON = "* * * * *";

/** Once a day, at 04:23. */
export const CODES_SWEEP_CRON = "23 4 * * *";

export const viewsSweepHandler =
  (deps: PreviewSweepDeps): JobHandler<"preview.views-sweep"> =>
  async (context) => {
    const closed = await sweepPreviewViews(deps);
    const total = Object.values(closed).reduce((sum, count) => sum + count, 0);
    if (total > 0) {
      context.logger.info("preview.views-swept", { ...closed });
    }
  };

export const codesSweepHandler =
  (deps: Pick<PreviewSweepDeps, "db" | "clock">): JobHandler<"preview.codes-sweep"> =>
  async (context) => {
    const removed = await sweepPreviewCodes(deps);
    if (removed > 0) {
      context.logger.info("preview.codes-swept", { removed });
    }
  };

export const ensurePreviewSweepSchedules = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("preview.views-sweep", "every-minute", VIEWS_SWEEP_CRON, {});
  await jobs.schedule("preview.codes-sweep", "daily", CODES_SWEEP_CRON, {});
};
