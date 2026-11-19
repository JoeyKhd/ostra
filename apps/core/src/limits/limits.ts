import type { Logger } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { recordLimitReached } from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, JobQueue, SessionTimers } from "@ostra/domain";
import type { JobHandler, Jobs } from "@ostra/jobs";
import { organizationIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, SessionId, SessionLimit, TaskId } from "@ostra/protocol";
import { z } from "zod";

// Runaway protection on the server (ticket 19, F-068, ADR 0037): the maximum duration, one delayed
// job per session, and the stall sweep, one keyed job a minute over the running sessions' last
// stored agent event. Both stop the session through `recordLimitReached`, which records the limit
// as core's own event, sends `stop` (reason `runaway`), and raises `stalled` for the driver. The
// spend cap is the key proxy's (ticket 25): its `session.limit_reached` reaches the same use case
// from ingest. Every time comes from the `Clock` port, so tests run the limits in seconds.

export type LimitDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly timers?: SessionTimers;
  /** `OSTRA_SESSION_STALL_MINUTES`, in ms. */
  readonly stallMs: number;
};

/** The stall sweep's tick: once a minute, so a stall of 10 minutes is noticed within 10 to 11. */
export const STALL_SWEEP_CRON = "* * * * *";

/** The kinds of needs-you item that mean a turn waits on a person: not a stall (the idle timer handles it). */
const WAITING_REASONS = ["approval", "question", "plan"] as const;

const stop = async (
  deps: LimitDeps,
  tx: Tx,
  session: { readonly organizationId: OrganizationId; readonly taskId: TaskId; readonly sessionId: SessionId },
  limit: SessionLimit,
  observed: number,
): Promise<boolean> => {
  const result = await recordLimitReached(
    {
      tx,
      outbox: deps.outbox,
      jobs: deps.jobs,
      notices: deps.notices,
      clock: deps.clock,
      logger: deps.logger,
      ...(deps.timers === undefined ? {} : { timers: deps.timers }),
    },
    { ...session, limit, observed, by: "core" },
  );
  return result.ok;
};

const minutesSince = (now: number, at: Date): number => Math.max(0, Math.round((now - at.getTime()) / 60_000));

/**
 * `session.max-duration`: wakes once per session window. A session still in a turn (running, or
 * waiting on a person) is stopped; an idle or ended one is left alone, and the idle timer or a later
 * turn's fresh window takes over (ADR 0037: re-read the subject, do nothing if it moved on).
 */
export const maxDurationHandler =
  (deps: LimitDeps): JobHandler<"session.max-duration"> =>
  async (context) => {
    const { payload } = context;
    const outcome = await deps.db.$transaction(async (tx) => {
      const session = await tx.session.findFirst({
        where: { id: payload.sessionId, taskId: payload.taskId, organizationId: payload.organizationId },
        select: { state: true, startedAt: true },
      });
      if (session === null) {
        return "missing";
      }
      if (session.state !== "running" && session.state !== "waiting") {
        return "not-in-a-turn";
      }
      return (await stop(deps, tx, payload, "max-duration", minutesSince(deps.clock.now(), session.startedAt))) ? "stopped" : "moved-on";
    });
    context.logger.info("session.max-duration", { taskId: payload.taskId, sessionId: payload.sessionId, outcome });
  };

const staleRowSchema = z.object({ id: z.string(), taskId: z.string(), organizationId: z.string(), lastAt: z.date() });

/** The running sessions whose last agent event is older than the cutoff, and that no person holds. */
const staleSessions = async (db: Pick<Tx, "$queryRaw">, cutoff: Date, sessionId?: string) => {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT s."id", s."taskId", s."organizationId",
           COALESCE((SELECT MAX(e."createdAt") FROM "event" e WHERE e."sessionId" = s."id" AND e."sessionSeq" IS NOT NULL), s."updatedAt") AS "lastAt"
    FROM "session" s
    WHERE s."state" = 'running'
      AND (${sessionId ?? null}::text IS NULL OR s."id" = ${sessionId ?? null})
      AND NOT EXISTS (SELECT 1 FROM "approval" a WHERE a."sessionId" = s."id" AND a."state" = 'open')
      AND NOT EXISTS (
        SELECT 1 FROM "needs_you_item" n
        WHERE n."taskId" = s."taskId" AND n."state" = 'open' AND n."reason"::text = ANY(${[...WAITING_REASONS]}::text[])
      )`;
  return rows
    .map((row) => staleRowSchema.parse(row))
    .filter((row) => row.lastAt.getTime() < cutoff.getTime());
};

/** One pass of the stall sweep: the sessions it stopped. */
export const sweepStalledSessions = async (deps: LimitDeps): Promise<number> => {
  const now = deps.clock.now();
  const cutoff = new Date(now - deps.stallMs);
  let stopped = 0;
  for (const candidate of await staleSessions(deps.db, cutoff)) {
    const done = await deps.db.$transaction(async (tx) => {
      // Under the task's lock ingest writes under, so an event that just arrived is seen.
      await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${candidate.taskId} FOR NO KEY UPDATE`;
      const [still] = await staleSessions(tx, cutoff, candidate.id);
      if (still === undefined) {
        return false;
      }
      return stop(
        deps,
        tx,
        {
          organizationId: organizationIdSchema.parse(still.organizationId),
          taskId: taskIdSchema.parse(still.taskId),
          sessionId: sessionIdSchema.parse(still.id),
        },
        "stall",
        minutesSince(now, still.lastAt),
      );
    });
    if (done) {
      stopped += 1;
    }
  }
  return stopped;
};

export const stallSweepHandler =
  (deps: LimitDeps): JobHandler<"session.stall-sweep"> =>
  async (context) => {
    const stopped = await sweepStalledSessions(deps);
    if (stopped > 0) {
      context.logger.info("session.stall-sweep", { stopped });
    }
  };

/** The minute's schedule: one tick a minute however many replicas run. */
export const ensureStallSweepSchedule = async (jobs: Pick<Jobs, "schedule">): Promise<void> => {
  await jobs.schedule("session.stall-sweep", "every-minute", STALL_SWEEP_CRON, {});
};
