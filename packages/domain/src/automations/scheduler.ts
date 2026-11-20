import type { Tx } from "@ostra/db";
import { agentProfileIdSchema, automationIdSchema, organizationIdSchema, projectIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { AutomationId, OrganizationId, TaskId } from "@ostra/protocol";

import type { M6Deps, RunOccurrence, StartTaskOptions, TickScheduler } from "../use-cases/m6-signatures.ts";
import { startTask } from "../starts/start-task-body.ts";
import type { StartPorts } from "../starts/start-task-body.ts";
import { BULK_START_MAX_DEFAULT } from "../starts/bulk.ts";
import { minimumIntervalOk, nextOccurrence, parseCron, planOccurrences } from "./cron.ts";
import type { Cron } from "./cron.ts";
import { filterTicketOf } from "./intake.ts";
import { matchesFilter, parseIntakeFilter } from "./intake-filter.ts";
import { SCHEDULE_MIN_INTERVAL_MINUTES_DEFAULT } from "./manage.ts";

// The scheduler (F-106, ADR 0037 amended, ADR 0056, Q211; milestone 6's ticket 10). `scheduler.tick`
// is a pg-boss schedule once a minute; it's idempotent, so pg-boss's own cron is enough for the tick
// itself. For each due schedule, in one transaction, read with `FOR UPDATE SKIP LOCKED`: the
// occurrence's `automation_run` row inserted with `ON CONFLICT DO NOTHING` (Prisma's
// `skipDuplicates`), its `automation.occurrence` job through `enqueueInTx`, and `nextOccurrenceAt`
// advanced by ostra's cron evaluator in the schedule's zone. Occurrences more than
// `OSTRA_SCHEDULE_MISSED_HOURS` late are recorded `missed` with one audit entry per catch-up; of
// those under it only the latest fires. The row is inserted as `started` with no task: the
// occurrence's job sets its task, or moves it to `skipped`. A prompt schedule's prompt is never logged.
//
// The minimum interval (`OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`) is checked at each tick as well as
// at the save (ticket 41): a schedule saved under a lower setting keeps its pattern, and fires at
// most once in that many minutes after the setting rises.

/** `OSTRA_SCHEDULE_MISSED_HOURS`'s default. */
export const SCHEDULE_MISSED_HOURS_DEFAULT = 6;

const MINUTE_MS = 60_000;

/** `minimumIntervalOk` walks a year of occurrences (about 0.1 s for an hourly one): its answer, kept per pattern, zone and setting. */
const intervalAnswers = new Map<string, boolean>();

const holdsMinimumInterval = (cron: Cron, minutes: number, timeZone: string): boolean => {
  const key = `${String(minutes)}\u0000${timeZone}\u0000${cron.source}`;
  const known = intervalAnswers.get(key);
  if (known !== undefined) {
    return known;
  }
  if (intervalAnswers.size >= 1_000) {
    intervalAnswers.clear();
  }
  const answer = minimumIntervalOk(cron, minutes, timeZone);
  intervalAnswers.set(key, answer);
  return answer;
};

export type SchedulerOptions = StartTaskOptions & {
  /** `OSTRA_SCHEDULE_MISSED_HOURS`. */
  readonly scheduleMissedHours?: number;
  /** `OSTRA_SCHEDULE_MIN_INTERVAL_MINUTES`, held at each tick. */
  readonly scheduleMinIntervalMinutes?: number;
  /** `OSTRA_BULK_START_MAX`: the most matches one occurrence of a filter schedule starts. */
  readonly bulkStartMax?: number;
  /**
   * A test seam (ticket 37's schedule hunt): called inside a step's transaction, just before it
   * commits, so a failure-suite process can end itself there (core's kill points). `tick.written`:
   * a schedule's occurrence, its job and its next time are written; `occurrence.started`: the
   * occurrence's task is started and recorded on its row. Core passes its kill points, which do
   * nothing unless a test process armed one.
   */
  readonly onStep?: (step: SchedulerStep) => void;
};

/** Where `onStep` is called: the last moment of a tick's or an occurrence's transaction. */
export type SchedulerStep = "tick.written" | "occurrence.started";

/** The ports a scheduler step takes inside its transaction. */
type TickTxDeps = Pick<M6Deps, "jobs" | "audit" | "notices" | "clock"> & SchedulerOptions;

/** What one schedule's tick did: the occurrence it fired (inserted), and how many it recorded missed. */
export type TickOne = { readonly fired: number | null; readonly missed: number };

/**
 * One schedule's tick, in the caller's transaction: nothing when another tick holds it, or it's no
 * longer due, enabled, unpaused and undeleted.
 */
export const tickAutomationInTx = async (deps: TickTxDeps, tx: Tx, automationId: AutomationId, now: number): Promise<TickOne> => {
  const locked = await tx.$queryRaw<readonly { readonly id: string }[]>`
      SELECT "id" FROM "automation"
      WHERE "id" = ${automationId} AND "schedule" IS NOT NULL AND "enabled" AND "deletedAt" IS NULL AND "pausedAt" IS NULL
        AND "nextOccurrenceAt" IS NOT NULL AND "nextOccurrenceAt" <= ${new Date(now)}
      FOR UPDATE SKIP LOCKED`;
  if (locked.length === 0) {
    return { fired: null, missed: 0 };
  }
  const row = await tx.automation.findUniqueOrThrow({ where: { id: automationId } });
  const organizationId = organizationIdSchema.parse(row.organizationId);
  const projectId = projectIdSchema.parse(row.projectId);
  const parsed = row.schedule === null ? null : parseCron(row.schedule);
  if (parsed === null || !parsed.ok || row.nextOccurrenceAt === null) {
    // A stored schedule that no longer parses waits for an edit; it never fires on a guess.
    await tx.automation.update({ where: { id: row.id }, data: { nextOccurrenceAt: null } });
    return { fired: null, missed: 0 };
  }
  // Everything before the next occurrence was handled, or skipped on purpose by an edit or a resume.
  const plan = planOccurrences({
    cron: parsed.cron,
    timeZone: row.timeZone,
    since: row.nextOccurrenceAt.getTime() - 1,
    now,
    missedHours: deps.scheduleMissedHours ?? SCHEDULE_MISSED_HOURS_DEFAULT,
  });
  // A schedule that fires more often than the install allows now (saved under a lower setting) is
  // held to it: an occurrence closer than the interval to the last one fired doesn't fire, and the
  // next one due is the first the interval allows.
  const minIntervalMs = (deps.scheduleMinIntervalMinutes ?? SCHEDULE_MIN_INTERVAL_MINUTES_DEFAULT) * MINUTE_MS;
  const held = !holdsMinimumInterval(parsed.cron, minIntervalMs / MINUTE_MS, row.timeZone);
  const lastFired = row.lastOccurrenceAt?.getTime() ?? null;
  const fire = plan.fire !== null && held && lastFired !== null && plan.fire - lastFired < minIntervalMs ? null : plan.fire;
  const since = fire ?? lastFired;
  const next = held && since !== null ? nextOccurrence(parsed.cron, row.timeZone, Math.max(now, since + minIntervalMs - 1)) : plan.next;
  const at = new Date(now);
  let fired: number | null = null;
  if (fire !== null) {
    const [inserted] = await tx.automationRun.createManyAndReturn({
      data: [{ organizationId, projectId, automationId, kind: "occurrence", occurrenceAt: new Date(fire), state: "started", createdAt: at }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (inserted !== undefined) {
      await deps.jobs.enqueueInTx(tx, "automation.occurrence", { organizationId, automationId, occurrenceAt: fire });
      fired = fire;
    }
  }
  if (plan.missed.length > 0) {
    await tx.automationRun.createMany({
      data: plan.missed.map((occurrenceAt) => ({ organizationId, projectId, automationId, kind: "occurrence" as const, occurrenceAt: new Date(occurrenceAt), state: "missed" as const, createdAt: at })),
      skipDuplicates: true,
    });
  }
  if (plan.missedCount > 0) {
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId,
      actor: { kind: "system", id: null },
      action: "automation.occurrences-missed",
      entity: "automation",
      entityId: automationId,
      data: { missed: plan.missedCount, firstMissedAt: plan.missed[0] ?? null, lastMissedAt: plan.missed.at(-1) ?? null },
    });
  }
  const last = fire ?? plan.missed.at(-1) ?? null;
  await tx.automation.update({
    where: { id: row.id },
    data: { nextOccurrenceAt: next === null ? null : new Date(next), ...(last === null ? {} : { lastOccurrenceAt: new Date(last) }) },
  });
  await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
  if (fired !== null) {
    deps.onStep?.("tick.written");
  }
  return { fired, missed: plan.missedCount };
};

export const tickScheduler = async (deps: StartPorts & SchedulerOptions): ReturnType<TickScheduler> => {
  const now = deps.clock.now();
  const due = await deps.db.automation.findMany({
    where: { schedule: { not: null }, enabled: true, deletedAt: null, pausedAt: null, nextOccurrenceAt: { lte: new Date(now) } },
    select: { id: true },
    orderBy: { nextOccurrenceAt: "asc" },
  });
  let occurrences = 0;
  let missed = 0;
  for (const { id } of due) {
    // One transaction per schedule: one schedule's failure leaves the others' occurrences in place.
    const one = await deps.db.$transaction((tx) => tickAutomationInTx(deps, tx, automationIdSchema.parse(id), now));
    occurrences += one.fired === null ? 0 : 1;
    missed += one.missed;
  }
  return { occurrences, missed };
};

/** The states a task's work is over in: merged, done or stopped. */
const CLOSED_TASK_STATES = ["merged", "done", "stopped"] as const;

type OccurrenceResult = Awaited<ReturnType<RunOccurrence>>;

/**
 * `automation.occurrence`: the occurrence's start through `startTask`, or its skip. It re-reads the
 * automation, so a pause, an edit or a delete since the tick wins: a paused or deleted automation's
 * occurrence is recorded `skipped: paused`. With "skip while the last one is open", it skips while
 * any task the automation started is still open (not merged, done or stopped). A prompt schedule
 * starts its one task; a filter schedule starts each open match the automation hasn't started, up
 * to the bulk limit, each in its own transaction, each as the rule's one match of that ticket.
 */
export const runOccurrence = async (deps: StartPorts & SchedulerOptions, input: Parameters<RunOccurrence>[1]): ReturnType<RunOccurrence> => {
  const decided = await deps.db.$transaction(async (tx): Promise<OccurrenceResult | { readonly ok: true; readonly state: "filter"; readonly taskId: null }> => {
    const locked = await tx.$queryRaw<readonly { readonly id: string }[]>`
        SELECT "id" FROM "automation_run"
        WHERE "automationId" = ${input.automationId} AND "organizationId" = ${input.organizationId} AND "kind" = 'occurrence' AND "occurrenceAt" = ${new Date(input.occurrenceAt)}
        FOR UPDATE`;
    const runId = locked[0]?.id;
    if (runId === undefined) {
      return { ok: false, error: "not-found", message: "No such occurrence" };
    }
    const run = await tx.automationRun.findUniqueOrThrow({ where: { id: runId } });
    // A replayed job finds the occurrence decided.
    if (run.state !== "started" || run.taskId !== null) {
      return { ok: true, state: run.state, taskId: run.taskId === null ? null : taskIdSchema.parse(run.taskId) };
    }
    const skip = async (reason: "paused" | "last_open"): Promise<OccurrenceResult> => {
      await tx.automationRun.update({ where: { id: run.id }, data: { state: "skipped", skipReason: reason } });
      await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: projectIdSchema.parse(run.projectId), entity: "project", entityId: projectIdSchema.parse(run.projectId) });
      return { ok: true, state: "skipped", taskId: null };
    };
    const automation = await tx.automation.findFirst({ where: { id: input.automationId, organizationId: input.organizationId } });
    if (automation?.deletedAt !== null || automation.pausedAt !== null || !automation.enabled || automation.schedule === null) {
      return skip("paused");
    }
    if (automation.skipWhileOpen) {
      const open = await tx.task.findFirst({ where: { automationId: automation.id, organizationId: input.organizationId, state: { notIn: [...CLOSED_TASK_STATES] } }, select: { id: true } });
      if (open !== null) {
        return skip("last_open");
      }
    }
    if (automation.prompt === null) {
      return { ok: true, state: "filter", taskId: null };
    }
    const started = await startTask(
      { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, ...(deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl }) },
      {
        organizationId: input.organizationId,
        projectId: projectIdSchema.parse(automation.projectId),
        origin: { kind: "occurrence", automationId: input.automationId, occurrenceAt: input.occurrenceAt, requireApproval: automation.requireApproval },
        kind: automation.taskKind,
        ticketId: null,
        prompt: automation.prompt,
        title: automation.title ?? automation.name,
        agentProfileId: automation.agentProfileId === null ? null : agentProfileIdSchema.parse(automation.agentProfileId),
        poolLabels: automation.poolLabels,
      },
    );
    if (!started.ok) {
      // The project's setup refused it (no repo, no profile with a model): the occurrence stays
      // without a task, and the next one tries again. A model no provider on the project's list
      // serves isn't a refusal: the task is made and waits queued with the reason (F-135).
      return { ok: true, state: "started", taskId: null };
    }
    await tx.automationRun.update({ where: { id: run.id }, data: { taskId: started.taskId } });
    deps.onStep?.("occurrence.started");
    return { ok: true, state: "started", taskId: started.taskId };
  });
  if (!decided.ok || decided.state !== "filter") {
    return decided;
  }
  await startFilterMatches(deps, input.organizationId, input.automationId, input.occurrenceAt);
  return { ok: true, state: "started", taskId: null };
};

/** A filter schedule's occurrence: each open match not yet started by the automation, up to the bulk limit. */
const startFilterMatches = async (deps: StartPorts & SchedulerOptions, organizationId: OrganizationId, automationId: AutomationId, occurrenceAt: number): Promise<readonly TaskId[]> => {
  const automation = await deps.db.automation.findFirst({ where: { id: automationId, organizationId } });
  const filter = automation === null ? null : parseIntakeFilter(automation.filter);
  if (automation === null || filter?.ok !== true) {
    return [];
  }
  const already = await deps.db.automationRun.findMany({ where: { automationId, kind: "ticket_match" }, select: { ticketId: true } });
  const done = new Set(already.map((row) => row.ticketId));
  const tickets = await deps.db.ticket.findMany({
    where: { organizationId, projectId: automation.projectId, open: true, removedAt: null, board: { detachedAt: null } },
    include: { connection: { select: { appUserId: true } } },
    orderBy: [{ trackerUpdatedAt: "asc" }, { id: "asc" }],
  });
  const matches = tickets.filter((ticket) => !done.has(ticket.id) && matchesFilter(filterTicketOf(ticket), filter.filter, { appUserId: ticket.connection.appUserId }));
  const started: TaskId[] = [];
  for (const ticket of matches.slice(0, deps.bulkStartMax ?? BULK_START_MAX_DEFAULT)) {
    const taskId = await deps.db.$transaction(async (tx): Promise<TaskId | null> => {
      const [run] = await tx.automationRun.createManyAndReturn({
        data: [{ organizationId, projectId: automation.projectId, automationId, kind: "ticket_match", ticketId: ticket.id, state: "started", createdAt: new Date(deps.clock.now()) }],
        skipDuplicates: true,
        select: { id: true },
      });
      if (run === undefined) {
        return null;
      }
      const result = await startTask(
        { tx, jobs: deps.jobs, notices: deps.notices, audit: deps.audit, clock: deps.clock, ...(deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl }) },
        {
          organizationId,
          projectId: projectIdSchema.parse(automation.projectId),
          origin: { kind: "occurrence", automationId, occurrenceAt, requireApproval: automation.requireApproval },
          kind: automation.taskKind,
          ticketId: ticketIdSchema.parse(ticket.id),
          prompt: null,
          title: null,
          agentProfileId: automation.agentProfileId === null ? null : agentProfileIdSchema.parse(automation.agentProfileId),
          poolLabels: automation.poolLabels,
        },
      );
      if (result.ok) {
        await tx.automationRun.update({ where: { id: run.id }, data: { taskId: result.taskId } });
        return result.taskId;
      }
      if (result.error === "ticket-has-active-task") {
        await tx.automationRun.update({ where: { id: run.id }, data: { state: "skipped", skipReason: "has_task" } });
      } else {
        await tx.automationRun.delete({ where: { id: run.id } });
      }
      return null;
    });
    if (taskId !== null) {
      started.push(taskId);
    }
  }
  return started;
};
