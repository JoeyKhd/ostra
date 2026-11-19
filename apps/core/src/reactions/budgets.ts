import type { Db } from "@ostra/db";
import { checkBudgetNotice, releaseForNewMonth, releaseHeldTurns } from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, JobQueue } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";

// Budget notices and their release (F-037, F-115, ADR 0055, ADR 0050; ticket 13): the workers of
// `budget.check`, `budget.release` and `budget.new-month`, and the new month's schedule. The rules
// are the domain's (`use-cases/budget-notices.ts`); each worker is one call and a log line of IDs.

export type BudgetJobDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  /** `OSTRA_BUDGET_WARN_PERCENT`. */
  readonly budgetWarnPercent: number;
  /** `OSTRA_EMAIL_DELAY_SECONDS`, which the instance's saved delay overrides. */
  readonly emailDelaySeconds: number;
};

/** A new month begins at 00:00 UTC on the 1st; its release runs five minutes later. */
export const BUDGET_NEW_MONTH_CRON = "5 0 1 * *";

export const budgetCheckHandler =
  (deps: BudgetJobDeps): JobHandler<"budget.check"> =>
  async (context) => {
    const result = await checkBudgetNotice(deps, context.payload);
    context.logger.info("budget.check", {
      budgetId: context.payload.budgetId,
      month: context.payload.month,
      threshold: context.payload.threshold,
      result: result.kind,
      ...(result.kind === "sent" ? { notifications: result.notifications, deliveries: result.deliveries } : {}),
    });
  };

export const budgetReleaseHandler =
  (deps: BudgetJobDeps): JobHandler<"budget.release"> =>
  async (context) => {
    const result = await releaseHeldTurns(deps, { organizationId: context.payload.organizationId, budgetId: context.payload.budgetId });
    context.logger.info("budget.release", { budgetId: context.payload.budgetId, released: result.released, stillHeld: result.stillHeld, reoffered: result.reoffered });
  };

export const budgetNewMonthHandler =
  (deps: BudgetJobDeps): JobHandler<"budget.new-month"> =>
  async (context) => {
    const budgets = await releaseForNewMonth(deps);
    context.logger.info("budget.new-month", { budgets });
  };

/** The new month's schedule: one tick a month however many replicas run. */
export const ensureBudgetNewMonthSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("budget.new-month", "monthly", BUDGET_NEW_MONTH_CRON, {}, { singletonSeconds: 86_400 });
};
