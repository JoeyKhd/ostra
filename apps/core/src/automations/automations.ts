import type { Db } from "@ostra/db";
import { matchIntakeRules, startBulkItem } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, CommandOutbox, JobQueue, TeamSettings } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";

// Automations' workers (F-011, F-106, F-107, ADR 0056; milestone 6's tickets 10 and 11):
// `scheduler.tick` (a pg-boss schedule, once a minute), `automation.occurrence`, `intake.match` and
// `bulk.start-item`. The rules are the domain's (`automations/`, `starts/`); each worker is one call
// and a log line of IDs and counts, never a prompt, a filter's values or a ticket's text.

export type AutomationJobDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly audit: AuditLog;
  readonly clock: Clock;
  /** The panel's address: the link to a ticket task that goes on its ticket. */
  readonly publicUrl: string;
  readonly team: Pick<TeamSettings, "scheduleMissedHours" | "intakeStartsPerHour" | "bulkStartMax">;
};

const options = (deps: AutomationJobDeps) => ({
  publicUrl: deps.publicUrl,
  scheduleMissedHours: deps.team.scheduleMissedHours,
  intakeStartsPerHour: deps.team.intakeStartsPerHour,
  bulkStartMax: deps.team.bulkStartMax,
});

export const intakeMatchHandler =
  (deps: AutomationJobDeps): JobHandler<"intake.match"> =>
  async (context) => {
    const result = await deps.db.$transaction((tx) => matchIntakeRules({ tx, ...deps, ...options(deps) }, context.payload));
    if (result.started.length > 0 || result.skipped.length > 0) {
      context.logger.info("intake.match", {
        ticketId: context.payload.ticketId,
        started: result.started.join(","),
        skipped: result.skipped.map((skip) => `${skip.automationId}:${skip.reason}`).join(","),
      });
    }
  };

export const bulkStartItemHandler =
  (deps: AutomationJobDeps): JobHandler<"bulk.start-item"> =>
  async (context) => {
    const result = await startBulkItem({ ...deps, ...options(deps) }, context.payload);
    context.logger.info("bulk.start-item", { bulkStartItemId: context.payload.bulkStartItemId, state: result.state, reason: result.reason, taskId: result.taskId });
  };

/** Registers the intake and bulk-start workers. */
export const startAutomationWorkers = async (jobs: Jobs, deps: AutomationJobDeps): Promise<void> => {
  await jobs.work("intake.match", intakeMatchHandler(deps), { localConcurrency: 4 });
  await jobs.work("bulk.start-item", bulkStartItemHandler(deps), { localConcurrency: 4 });
};
