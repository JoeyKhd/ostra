import type { Db } from "@ostra/db";
import { EVERY_MINUTE_CRON, matchIntakeRules, runOccurrence, startBulkItem, tickScheduler } from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, CommandOutbox, JobQueue, SchedulerStep, TeamSettings } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";

import { killPoint } from "../kill-points.ts";

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
  readonly team: Pick<TeamSettings, "scheduleMissedHours" | "scheduleMinIntervalMinutes" | "intakeStartsPerHour" | "bulkStartMax">;
};

/** The scheduler's steps, as core's kill points (ticket 37's hunt): nothing unless a test process armed one. */
const schedulerKillPoint = (step: SchedulerStep): void => {
  switch (step) {
    case "tick.written":
      killPoint("scheduler.tick-written");
      return;
    case "occurrence.started":
      killPoint("automation.occurrence-started");
      return;
    default:
      step satisfies never;
  }
};

const options = (deps: AutomationJobDeps) => ({
  onStep: schedulerKillPoint,
  publicUrl: deps.publicUrl,
  scheduleMissedHours: deps.team.scheduleMissedHours,
  scheduleMinIntervalMinutes: deps.team.scheduleMinIntervalMinutes,
  intakeStartsPerHour: deps.team.intakeStartsPerHour,
  bulkStartMax: deps.team.bulkStartMax,
});

export const schedulerTickHandler =
  (deps: AutomationJobDeps): JobHandler<"scheduler.tick"> =>
  async (context) => {
    const result = await tickScheduler({ ...deps, ...options(deps) });
    if (result.occurrences > 0 || result.missed > 0) {
      context.logger.info("scheduler.tick", { occurrences: result.occurrences, missed: result.missed });
    }
  };

export const occurrenceHandler =
  (deps: AutomationJobDeps): JobHandler<"automation.occurrence"> =>
  async (context) => {
    const result = await runOccurrence({ ...deps, ...options(deps) }, context.payload);
    killPoint("automation.occurrence-committed");
    context.logger.info("automation.occurrence", {
      automationId: context.payload.automationId,
      occurrenceAt: context.payload.occurrenceAt,
      ...(result.ok ? { state: result.state, taskId: result.taskId } : { error: result.error }),
    });
  };

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

/** The tick's schedule: once a minute however many replicas run; the tick itself is idempotent. */
export const ensureSchedulerTick = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("scheduler.tick", "every-minute", EVERY_MINUTE_CRON, {});
};

/** Registers the four workers and the tick's schedule. */
export const startAutomationWorkers = async (jobs: Jobs, deps: AutomationJobDeps): Promise<void> => {
  await jobs.work("scheduler.tick", schedulerTickHandler(deps), { localConcurrency: 1 });
  await jobs.work("automation.occurrence", occurrenceHandler(deps), { localConcurrency: 2 });
  await jobs.work("intake.match", intakeMatchHandler(deps), { localConcurrency: 4 });
  await jobs.work("bulk.start-item", bulkStartItemHandler(deps), { localConcurrency: 4 });
  await ensureSchedulerTick(jobs);
};
