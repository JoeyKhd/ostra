import type { Logger } from "@ostra/adapter-sdk";
import { LIVE_TEXT_TABLE, mapTask, notifyChannels, Prisma } from "@ostra/db";
import type { Session, Tx } from "@ostra/db";
import { runnerEventSchema, runnerIdSchema, taskSeqSchema } from "@ostra/protocol";
import type { LeaseEpoch, RunnerEvent, SessionId, SessionSeq, TaskId, TaskSeq } from "@ostra/protocol";
import { z } from "zod";

import type { Ports } from "../ports.ts";
import { moveSessionInTx, moveTaskInTx } from "./moves.ts";
import { storableEvent } from "./storable-event.ts";
import type { MoveDeps } from "./moves.ts";

// ADR 0034, ADR 0035, F-045: one `events` frame, saved in one transaction. Idempotent on
// `(sessionId, sessionSeq)`; numbered per task under the task row's lock (so a grace sweep can't
// interleave); the lease epoch checked; reactions enqueued (`task.session-ended` for a
// `session.ended`); acked per session only after the commit. A batch that doesn't start at the
// session's cursor plus one gets `resendFrom`. A stale epoch is refused, never quarantined (Q111).
// Written by ticket 25; ported from spikes/live-stream-and-task-view/src/server/appender.ts and
// spikes/runner-transport/src/server/replica.ts (`ingest`).
//
// The lock: ADR 0034 as amended asks for a share lock on the task row for the epoch check. Ingest
// also takes the task's event counter, which is on that row, and upgrading a share lock to an update
// lock deadlocks two writers to one task. So the row is taken `FOR NO KEY UPDATE` from the start:
// the grace sweep's `FOR UPDATE` and the panel's own appends wait for it the same way, and foreign
// keys pointing at the task (`FOR KEY SHARE`) don't.

export const ingestEventsInputSchema = z.strictObject({
  runnerId: runnerIdSchema,
  events: z.array(runnerEventSchema).min(1),
});
export type IngestEventsInput = z.infer<typeof ingestEventsInputSchema>;

/** One session's outcome, which becomes its `ack` or `error` frame. */
export type SessionIngestOutcome =
  | {
      readonly kind: "saved";
      readonly sessionId: SessionId;
      readonly taskId: TaskId;
      /** The highest session number now saved. */
      readonly upTo: SessionSeq;
      /** The newest task number given, for the wake-up NOTIFY. */
      readonly headSeq: TaskSeq;
      readonly duplicates: number;
    }
  | { readonly kind: "gap"; readonly sessionId: SessionId; readonly upTo: number; readonly resendFrom: SessionSeq }
  | { readonly kind: "stale-lease"; readonly sessionId: SessionId; readonly currentEpoch: LeaseEpoch }
  | { readonly kind: "unknown-session"; readonly sessionId: SessionId };

export type IngestEventsResult = { readonly outcomes: readonly SessionIngestOutcome[] };

export type IngestEventsDeps = Pick<Ports, "jobs" | "notices" | "clock"> & {
  readonly tx: Tx;
  /** Where refused transitions are logged, with IDs only. */
  readonly logger?: Logger;
};

export type IngestEvents = (deps: IngestEventsDeps, input: IngestEventsInput) => Promise<IngestEventsResult>;

type LockedTask = ReturnType<typeof mapTask>;

/** Locks the task row for the batch (see the note on the lock above) and reads it. */
const lockTaskRow = async (tx: Tx, taskId: string): Promise<LockedTask | null> => {
  const locked = await tx.$queryRaw<readonly unknown[]>`SELECT 1 FROM "task" WHERE "id" = ${taskId} FOR NO KEY UPDATE`;
  const row = locked.length === 0 ? null : await tx.task.findUnique({ where: { id: taskId } });
  return row === null ? null : mapTask(row);
};

/** Groups a frame's events by session, keeping each session's order. */
const bySession = (events: readonly RunnerEvent[]): Map<SessionId, RunnerEvent[]> => {
  const groups = new Map<SessionId, RunnerEvent[]>();
  for (const item of events) {
    const group = groups.get(item.sessionId);
    if (group === undefined) {
      groups.set(item.sessionId, [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
};

type Stored = { readonly item: RunnerEvent; readonly seq: TaskSeq };

/** What the stored events imply, in the same transaction (ticket 25). */
const applyEffects = async (
  deps: IngestEventsDeps,
  task: LockedTask,
  session: Session,
  stored: readonly Stored[],
): Promise<void> => {
  const moveDeps: MoveDeps = { tx: deps.tx, notices: deps.notices, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  const { tx } = deps;
  // The rows move as the events go: re-read the session after each move so the next one sees it.
  let current = session;
  let taskRow: LockedTask = task;
  const reloadSession = async (): Promise<void> => {
    current = await tx.session.findUniqueOrThrow({ where: { id: session.id } });
  };
  const reloadTask = async (): Promise<void> => {
    taskRow = (await lockTaskRow(tx, task.id)) ?? taskRow;
  };
  for (const { item, seq } of stored) {
    const event = item.event;
    switch (event.kind) {
      case "turn.started": {
        const ordinal = (await tx.turn.count({ where: { sessionId: session.id } })) + 1;
        await tx.turn.create({
          data: {
            organizationId: task.organizationId,
            projectId: task.projectId,
            taskId: task.id,
            sessionId: session.id,
            ordinal,
            startSeq: seq,
            startedAt: new Date(item.at),
          },
        });
        if (current.state === "starting" || current.state === "idle") {
          await moveSessionInTx(moveDeps, current, { type: current.state === "starting" ? "agent_ready" : "turn_started" });
          await reloadSession();
        }
        if (taskRow.state !== "running") {
          await moveTaskInTx(moveDeps, taskRow, { type: "box_ready" });
          await reloadTask();
        }
        break;
      }
      case "turn.ended":
      case "turn.failed": {
        const open = await tx.turn.findFirst({
          where: { sessionId: session.id, endedAt: null },
          orderBy: { ordinal: "desc" },
          select: { id: true },
        });
        if (open !== null) {
          await tx.turn.update({
            where: { id: open.id },
            data: { endedAt: new Date(item.at), stopReason: event.kind === "turn.ended" ? event.stopReason : "failed" },
          });
        }
        await moveSessionInTx(moveDeps, current, { type: "turn_ended" });
        await reloadSession();
        break;
      }
      case "agent.message":
      case "agent.thought":
        // The completed text is the event: its partial text is gone (ADR 0035).
        await tx.$executeRaw`DELETE FROM ${Prisma.raw(LIVE_TEXT_TABLE)} WHERE "taskId" = ${task.id} AND "segmentId" = ${event.segmentId}`;
        break;
      case "usage.recorded":
        await tx.session.update({
          where: { id: session.id },
          data: {
            inputTokens: { increment: event.inputTokens },
            outputTokens: { increment: event.outputTokens },
            cacheReadTokens: { increment: event.cacheReadTokens },
            cacheWriteTokens: { increment: event.cacheWriteTokens },
          },
        });
        break;
      case "git.pushed":
        if (event.ref === `refs/heads/${event.branch}`) {
          await tx.taskRepo.updateMany({
            where: { taskId: task.id, repoId: event.repoId, branchName: event.branch },
            data: { headSha: event.headSha },
          });
        }
        break;
      case "pr.text_set":
        await tx.taskRepo.updateMany({
          where: { taskId: task.id, repoId: event.repoId },
          data: { prTitle: event.title, prBody: event.body },
        });
        break;
      case "session.ended":
        // The reaction runs as a job (ticket 27): PRs, or needs you when nothing changed.
        await deps.jobs.enqueueInTx(tx, "task.session-ended", {
          organizationId: task.organizationId,
          taskId: task.id,
          sessionId: item.sessionId,
          eventSeq: seq,
        });
        break;
      case "session.crashed": {
        // Needs you for the driver; the box failed; the branch and the hidden ref stay (ticket 27).
        await moveSessionInTx(moveDeps, current, { type: "crash" });
        await reloadSession();
        const moved = await moveTaskInTx(moveDeps, taskRow, { type: "crashed" });
        await reloadTask();
        if (moved) {
          await tx.needsYouItem.create({
            data: {
              organizationId: task.organizationId,
              projectId: task.projectId,
              taskId: task.id,
              reason: "crashed",
              audience: "driver",
            },
          });
        }
        if (current.boxId !== null) {
          await tx.box.updateMany({
            where: { id: current.boxId, state: { in: ["creating", "preparing", "ready", "idle"] } },
            data: { state: "failed", failedReason: "the session crashed" },
          });
        }
        break;
      }
      case "user.message":
      case "turn.cancel_requested":
      case "agent.content":
      case "tool.called":
      case "tool.progress":
      case "tool.completed":
      case "tool.failed":
      case "approval.requested":
      case "approval.answered":
      case "approval.auto_answered":
      case "approval.closed":
      case "question.asked":
      case "question.answered":
      case "question.closed":
      case "plan.updated":
      case "compaction.updated":
      case "session.config_changed":
      case "driver.changed":
      case "runner.connected":
      case "runner.lost":
      case "session.restored":
      case "pr.opened":
      case "agent.unknown":
      case "environment.setup_started":
      case "environment.setup_output":
      case "environment.setup_finished":
      case "session.usage":
        // Stored for the task page; nothing else moves.
        break;
      default:
        event satisfies never;
    }
  }
};

const ingestSession = async (
  deps: IngestEventsDeps,
  runnerId: string,
  sessionId: SessionId,
  items: readonly RunnerEvent[],
): Promise<SessionIngestOutcome> => {
  const { tx } = deps;
  const session = await tx.session.findUnique({ where: { id: sessionId } });
  if (session === null) {
    return { kind: "unknown-session", sessionId };
  }
  const task = await lockTaskRow(tx, session.taskId);
  if (task === null) {
    return { kind: "unknown-session", sessionId };
  }
  // The session is this runner's only if it holds, or held, a lease of the task. Another runner's
  // session, or another organization's, is unknown to it: nothing about it leaks.
  const epochs = new Set(items.map((item) => item.leaseEpoch));
  const leases = await tx.lease.findMany({
    where: { taskId: task.id, organizationId: task.organizationId, runnerId, epoch: { in: [...epochs] } },
    select: { epoch: true },
  });
  if (leases.length === 0) {
    return { kind: "unknown-session", sessionId };
  }
  // The fence (F-045): every event must carry the task's current epoch. The grace, or a newer
  // dispatch, raised it: the write is refused, never kept (Q111).
  if (items.some((item) => item.leaseEpoch !== task.leaseEpoch)) {
    return { kind: "stale-lease", sessionId, currentEpoch: task.leaseEpoch };
  }
  let cursor = session.ingestedSeq;
  const fresh: RunnerEvent[] = [];
  let duplicates = 0;
  let gap = false;
  for (const item of [...items].sort((a, b) => a.sessionSeq - b.sessionSeq)) {
    if (item.sessionSeq <= cursor) {
      duplicates += 1;
      continue;
    }
    if (item.sessionSeq !== cursor + 1) {
      // A gap can never be committed: what came before it is saved, the rest is asked for again.
      gap = true;
      break;
    }
    fresh.push(item);
    cursor = item.sessionSeq;
  }
  let headSeq = 0;
  const stored: Stored[] = [];
  if (fresh.length > 0) {
    const counter = await tx.task.update({
      where: { id: task.id },
      data: { eventSeq: { increment: fresh.length } },
      select: { eventSeq: true },
    });
    headSeq = counter.eventSeq;
    const firstSeq = headSeq - fresh.length + 1;
    fresh.forEach((item, index) => {
      stored.push({ item, seq: taskSeqSchema.parse(firstSeq + index) });
    });
    await tx.event.createMany({
      data: stored.map(({ item, seq }) => ({
        organizationId: task.organizationId,
        projectId: task.projectId,
        taskId: task.id,
        seq,
        sessionId,
        sessionSeq: item.sessionSeq,
        leaseEpoch: item.leaseEpoch,
        kind: item.event.kind,
        payload: storableEvent(item.event),
        occurredAt: new Date(item.at),
      })),
    });
    await tx.session.update({ where: { id: sessionId }, data: { ingestedSeq: cursor } });
    await applyEffects(deps, task, session, stored);
    // One wake-up per task per batch, which commits with it: IDs and the newest seq, never content.
    await tx.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.id, seq: headSeq })})`;
  } else {
    headSeq = task.eventSeq;
  }
  if (gap) {
    return { kind: "gap", sessionId, upTo: cursor, resendFrom: cursor + 1 };
  }
  return {
    kind: "saved",
    sessionId,
    taskId: task.id,
    upTo: cursor,
    headSeq: taskSeqSchema.parse(Math.max(1, headSeq)),
    duplicates,
  };
};

export const ingestEvents: IngestEvents = async (deps, input) => {
  const outcomes: SessionIngestOutcome[] = [];
  for (const [sessionId, items] of bySession(input.events)) {
    outcomes.push(await ingestSession(deps, input.runnerId, sessionId, items));
  }
  return { outcomes };
};
