import type { Logger } from "@ostra/adapter-sdk";
import { fanOutNotification } from "@ostra/domain";
import type { M3Deps } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// `notify.fanout` (F-036, ticket 20): an item was created, answered or dismissed, so write each
// audience member's notification and its deliveries. The domain's `fanOutNotification` does it in
// one transaction and enqueues the deliveries in it (ADR 0011); a replay writes nothing twice.

export type FanoutDeps = M3Deps & {
  readonly logger: Logger;
  /** `OSTRA_EMAIL_DELAY_SECONDS`, which the instance's saved delay overrides. */
  readonly emailDelaySeconds: number;
};

export const notifyFanoutHandler =
  (deps: FanoutDeps): JobHandler<"notify.fanout"> =>
  async (context) => {
    const { organizationId, needsYouItemId, change } = context.payload;
    if (needsYouItemId === null) {
      // A test mail's fan-out (ticket 21).
      context.logger.warn("notify.fanout-no-item", { change });
      return;
    }
    const result = await fanOutNotification(deps, { organizationId, itemId: needsYouItemId, change, emailDelaySeconds: deps.emailDelaySeconds });
    if (!result.ok) {
      // The item was deleted with its task before its fan-out ran: nothing is owed.
      context.logger.info("notify.fanout-item-gone", { itemId: needsYouItemId, change });
      return;
    }
    context.logger.info("notify.fanned-out", { itemId: needsYouItemId, change, notifications: result.notifications, deliveries: result.deliveries });
  };
