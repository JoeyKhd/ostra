import type { Logger } from "@ostra/adapter-sdk";
import { LIVE_TEXT_TABLE, notifyChannels, Prisma } from "@ostra/db";
import type { Db } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, runnerLimits, taskIdSchema } from "@ostra/protocol";
import type { LiveText, LiveTextFrame, OrganizationId, ProjectId, SegmentId, SessionId, TaskId, TurnId } from "@ostra/protocol";

import type { RunnerRef } from "../gateway/context.ts";

// Partial text (ADR 0035): what the agent is still writing. It's never an event: each open segment
// is one row in the UNLOGGED live-text table, upserted at most every 250 ms, with no transaction
// around anything else, and deleted when its completed message commits (by ingest). Ported from
// spikes/live-stream-and-task-view/src/server/appender.ts (the live half).
//
// A frame is applied only for a session of a task this runner holds the current lease of. A frame
// whose offset doesn't match the text held is dropped; the next snapshot (offset 0) repairs it.

type Segment = {
  readonly taskId: TaskId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly segmentId: SegmentId;
  readonly kind: LiveTextFrame["kind"];
  text: string;
  dirty: boolean;
  touchedAt: number;
};

type SessionGrant = {
  readonly taskId: TaskId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly checkedAt: number;
} | null;

export type LiveTextWriter = {
  readonly write: (runner: RunnerRef, frame: LiveText) => Promise<void>;
  /** The segment's completed text committed: forget it, and never write it again. */
  readonly complete: (taskId: TaskId, segmentId: SegmentId) => void;
  /** Writes what's pending now (tests, and shutdown). */
  readonly flush: () => Promise<void>;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
};

const GRANT_TTL_MS = 30_000;
const COMPLETED_TTL_MS = 60_000;
const ABANDONED_MS = 10 * 60_000;

const key = (taskId: TaskId, segmentId: SegmentId): string => `${taskId}\u0000${segmentId}`;

export const createLiveTextWriter = (options: {
  readonly db: Db;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly now?: () => number;
}): LiveTextWriter => {
  const { db, logger } = options;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? runnerLimits.liveTextIntervalMs;
  const segments = new Map<string, Segment>();
  const completed = new Map<string, number>();
  const grants = new Map<string, SessionGrant>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing: Promise<void> = Promise.resolve();

  /** Whether `sessionId` belongs to a task this runner holds the current lease of. */
  const grant = async (runner: RunnerRef, sessionId: SessionId): Promise<SessionGrant> => {
    const cacheKey = `${runner.runnerId}\u0000${sessionId}`;
    const cached = grants.get(cacheKey);
    if (cached !== undefined && cached !== null && now() - cached.checkedAt < GRANT_TTL_MS) {
      return cached;
    }
    const session = await db.session.findFirst({
      where: { id: sessionId, organizationId: runner.organizationId },
      select: { taskId: true, organizationId: true, projectId: true, task: { select: { leaseEpoch: true } } },
    });
    const lease =
      session === null
        ? null
        : await db.lease.findFirst({
            where: { taskId: session.taskId, runnerId: runner.runnerId, state: "active", epoch: session.task.leaseEpoch },
            select: { id: true },
          });
    const result: SessionGrant =
      session === null || lease === null
        ? null
        : {
            taskId: taskIdSchema.parse(session.taskId),
            organizationId: organizationIdSchema.parse(session.organizationId),
            projectId: projectIdSchema.parse(session.projectId),
            checkedAt: now(),
          };
    grants.set(cacheKey, result);
    return result;
  };

  const flushNow = async (): Promise<void> => {
    const dirty = [...segments.values()].filter((segment) => segment.dirty);
    if (dirty.length === 0) {
      return;
    }
    for (const segment of dirty) {
      segment.dirty = false;
    }
    const rows = dirty.map(
      (segment) =>
        Prisma.sql`(${segment.taskId}, ${segment.segmentId}, ${segment.organizationId}, ${segment.projectId}, ${segment.sessionId}, ${segment.turnId}, ${segment.kind}, ${segment.text}, now())`,
    );
    try {
      // Every open segment upserts its whole text so far: the UNLOGGED table's cost (spike 7).
      await db.$executeRaw`
        INSERT INTO ${Prisma.raw(LIVE_TEXT_TABLE)} ("taskId", "segmentId", "organizationId", "projectId", "sessionId", "turnId", "kind", "text", "updatedAt")
        VALUES ${Prisma.join(rows)}
        ON CONFLICT ("taskId", "segmentId") DO UPDATE SET "text" = EXCLUDED."text", "updatedAt" = now()`;
      // A wake-up per task, so the panel reads the new text now rather than at its next poll.
      for (const taskId of new Set(dirty.map((segment) => segment.taskId))) {
        await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId })})`;
      }
    } catch (error) {
      logger.warn("live-text.flush-failed", { segments: dirty.length, error: error instanceof Error ? error.name : "unknown" });
    }
    // A segment completed while its upsert was in flight: its row goes again.
    for (const segment of dirty) {
      if (completed.has(key(segment.taskId, segment.segmentId))) {
        await db.$executeRaw`DELETE FROM ${Prisma.raw(LIVE_TEXT_TABLE)} WHERE "taskId" = ${segment.taskId} AND "segmentId" = ${segment.segmentId}`;
      }
    }
  };

  const flush = (): Promise<void> => {
    flushing = flushing.then(flushNow, flushNow);
    return flushing;
  };

  const sweep = (): void => {
    const at = now();
    for (const [entry, when] of completed) {
      if (at - when > COMPLETED_TTL_MS) {
        completed.delete(entry);
      }
    }
    for (const [entry, segment] of segments) {
      if (at - segment.touchedAt > ABANDONED_MS) {
        segments.delete(entry);
      }
    }
    for (const [entry, value] of grants) {
      if (value === null || at - value.checkedAt > GRANT_TTL_MS) {
        grants.delete(entry);
      }
    }
  };

  return {
    write: async (runner, live) => {
      for (const frame of live.frames) {
        const allowed = await grant(runner, frame.sessionId);
        if (allowed?.taskId !== frame.taskId) {
          logger.info("live-text.refused", { runnerId: runner.runnerId, sessionId: frame.sessionId });
          continue;
        }
        const entry = key(frame.taskId, frame.segmentId);
        if (completed.has(entry)) {
          continue;
        }
        const segment = segments.get(entry);
        if (frame.offset === 0) {
          segments.set(entry, {
            taskId: frame.taskId,
            organizationId: allowed.organizationId,
            projectId: allowed.projectId,
            sessionId: frame.sessionId,
            turnId: frame.turnId,
            segmentId: frame.segmentId,
            kind: frame.kind,
            text: frame.text,
            dirty: true,
            touchedAt: now(),
          });
        } else if (segment?.text.length === frame.offset) {
          segment.text += frame.text;
          segment.dirty = true;
          segment.touchedAt = now();
        }
      }
    },
    complete: (taskId, segmentId) => {
      const entry = key(taskId, segmentId);
      segments.delete(entry);
      completed.set(entry, now());
    },
    flush,
    start: () => {
      timer ??= setInterval(() => {
        sweep();
        void flush();
      }, intervalMs);
    },
    stop: async () => {
      clearInterval(timer);
      timer = undefined;
      await flush();
    },
  };
};
