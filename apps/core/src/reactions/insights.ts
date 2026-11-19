import type { Db } from "@ostra/db";
import { computeAllInsights } from "@ostra/domain";
import type { Clock } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";

// The Insights job (F-108, ADR 0055, ADR 0035; ticket 14): `insights.compute` on a schedule every
// `OSTRA_INSIGHTS_INTERVAL_MINUTES`. Each organization's pass is the domain's `computeInsights`:
// ostra's own tables only, idempotent, under a per-organization advisory lock.

export type InsightsJobDeps = { readonly db: Db; readonly clock: Clock };

/** The cron for every `minutes` (1 to 1440): within the hour, by whole hours, or once a day. */
export const insightsCron = (minutes: number): string => {
  const whole = Math.max(1, Math.min(1440, Math.round(minutes)));
  if (whole === 1) return "* * * * *";
  if (whole < 60) return `*/${String(whole)} * * * *`;
  const hours = Math.max(1, Math.round(whole / 60));
  return hours >= 24 ? "0 0 * * *" : hours === 1 ? "0 * * * *" : `0 */${String(hours)} * * *`;
};

export const insightsComputeHandler =
  (deps: InsightsJobDeps): JobHandler<"insights.compute"> =>
  async (context) => {
    const results = await computeAllInsights(deps);
    for (const { organizationId, result } of results) {
      context.logger.info("insights.compute", { organizationId, days: result.days, tasks: result.tasks, written: result.written });
    }
  };

export const ensureInsightsSchedule = async (jobs: Pick<Jobs, "schedule">, intervalMinutes: number): Promise<void> => {
  await jobs.schedule("insights.compute", "all", insightsCron(intervalMinutes), {});
};
