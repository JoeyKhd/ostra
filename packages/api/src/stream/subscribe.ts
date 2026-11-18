import { mapEventToStored } from "@ostra/db";
import { requireProjectAccess } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { LIVE_TEXT_MAX_CHARS, projectIdSchema } from "@ostra/protocol";
import type { LiveTextFrame, ProjectId, SegmentId, StoredEvent, TaskId } from "@ostra/protocol";
import { tracked, TRPCError } from "@trpc/server";

import type { Context } from "../trpc/context.ts";
import { denied, loadProjectAccess } from "../trpc/init.ts";
import { createAsyncQueue } from "./async-queue.ts";
import type { ChangeNoticeRow, LiveUpdate } from "./hub.ts";

// The tRPC subscription over SSE (ADR 0035, ticket 33): one stream per tab. It multiplexes change
// notices for the member's organization and, when a task page is open, that task's committed events
// and live text.
//
// - Committed events are yielded with `tracked(seq)`, so a dropped stream reconnects with
//   `Last-Event-ID` and reads `seq > lastEventId` from the table. The generator subscribes to the hub
//   before it catches up from the table, so nothing slips through, and skips a seq it already sent,
//   so nothing is sent twice.
// - Live text is untracked: a snapshot of the open partial segments first, then deltas by offset. A
//   committed event replaces its segment's partial text on the client.
// - Change notices are untracked too: IDs only, a hint to refetch. A reconnect refetches the live
//   views, so a missed notice costs a refetch, never a wrong screen.
// - Every message is filtered by organization and project access before it is yielded, and the
//   membership is checked again on a timer, so a revoked member's open stream ends.
//
// The named `ping` every 15 s and the client's 20 s watchdog are tRPC's own SSE settings (init.ts).

export type StreamInput = {
  readonly taskId?: TaskId | undefined;
  /** Events at or before this seq are the page's (history); the stream starts after it. */
  readonly afterSeq?: number | undefined;
  /** What `httpSubscriptionLink` sends on a reconnect: the last `tracked` id it saw. */
  readonly lastEventId?: string | null | undefined;
};

export type StreamMessage =
  | { readonly type: "event"; readonly event: StoredEvent }
  | { readonly type: "live"; readonly frame: LiveTextFrame }
  | { readonly type: "live-end"; readonly segmentId: SegmentId }
  | { readonly type: "change"; readonly entity: string; readonly entityId: string; readonly projectId: ProjectId | null };

type Item =
  | { readonly kind: "events"; readonly events: readonly StoredEvent[] }
  | { readonly kind: "live"; readonly updates: readonly LiveUpdate[]; readonly ended: readonly SegmentId[] }
  | { readonly kind: "changes"; readonly notices: readonly ChangeNoticeRow[] };

const CATCH_UP_PAGE = 2000;
const QUEUE_CAPACITY = 50_000;
export const DEFAULT_RECHECK_MS = 30_000;

/** The seq a reconnect resumes from: `Last-Event-ID` when it is one, else the page's head. */
export const resumeSeq = (input: StreamInput): number => {
  const parsed = input.lastEventId === null || input.lastEventId === undefined ? Number.NaN : Number(input.lastEventId);
  const fromId = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  return Math.max(fromId, input.afterSeq ?? 0);
};

/** A live segment's text as frames: a snapshot (offset 0), or the delta from `offset`, each within the frame limit. */
const liveFrames = (taskId: TaskId, update: LiveUpdate, offset: number, text: string): readonly LiveTextFrame[] => {
  const frames: LiveTextFrame[] = [];
  for (let start = 0; start < text.length || (start === 0 && text.length === 0); start += LIVE_TEXT_MAX_CHARS) {
    frames.push({
      taskId,
      sessionId: update.sessionId,
      turnId: update.turnId,
      segmentId: update.segmentId,
      kind: update.kind,
      offset: offset + start,
      text: text.slice(start, start + LIVE_TEXT_MAX_CHARS),
    });
    if (text.length === 0) {
      break;
    }
  }
  return frames;
};

type OpenContext = Context & { readonly scope: MemberScope };

/** The stream's body: a generator `stream.subscribe` hands to tRPC. */
// eslint-disable-next-line func-style -- a generator can't be an arrow function
export async function* openStream(ctx: OpenContext, input: StreamInput, signal: AbortSignal | undefined) {
  const { deps } = ctx;
  const { db } = deps;
  const abort = signal ?? new AbortController().signal;
  let scope = ctx.scope;
  const recheckMs = deps.streamRecheckMs ?? DEFAULT_RECHECK_MS;

  // Access to the task, before anything is registered or read.
  let taskProjectId: ProjectId | null = null;
  if (input.taskId !== undefined) {
    const row = await db.task.findFirst({ where: { id: input.taskId, organizationId: scope.organizationId }, select: { projectId: true } });
    if (row === null) {
      throw denied("not-found", "task");
    }
    taskProjectId = projectIdSchema.parse(row.projectId);
    await loadProjectAccess(db, scope, taskProjectId, "read").catch(() => {
      throw denied("not-found", "task");
    });
  }

  const queue = createAsyncQueue<Item>(QUEUE_CAPACITY);
  const unsubscribers: (() => void)[] = [];
  try {
    unsubscribers.push(
      await deps.stream.subscribeChanges({
        deliverChanges: (notices) => {
          queue.push({ kind: "changes", notices });
        },
      }),
    );

    let startCursor = 0;
    let liveSnapshot: readonly LiveUpdate[] = [];
    if (input.taskId !== undefined) {
      const subscription = await deps.stream.subscribeTask(input.taskId, {
        deliverEvents: (events) => {
          queue.push({ kind: "events", events });
        },
        deliverLive: (updates, ended) => {
          queue.push({ kind: "live", updates, ended });
        },
      });
      unsubscribers.push(subscription.unsubscribe);
      startCursor = subscription.startCursor;
      liveSnapshot = subscription.liveSnapshot;
    }

    let lastSeq = resumeSeq(input);
    const liveSent = new Map<SegmentId, number>();

    // ---- catch up from the table: (resume point, the hub's start cursor] ----
    if (input.taskId !== undefined) {
      const taskId = input.taskId;
      let cursor = lastSeq;
      while (cursor < startCursor && !abort.aborted) {
        const page = await db.event.findMany({
          where: { taskId, organizationId: scope.organizationId, seq: { gt: cursor, lte: startCursor } },
          orderBy: { seq: "asc" },
          take: CATCH_UP_PAGE,
        });
        if (page.length === 0) {
          break;
        }
        for (const row of page) {
          const event = mapEventToStored(row);
          cursor = event.seq;
          lastSeq = event.seq;
          yield tracked(String(event.seq), { type: "event", event } satisfies StreamMessage);
        }
      }
      for (const update of liveSnapshot) {
        for (const frame of liveFrames(taskId, update, 0, update.text)) {
          yield { type: "live", frame } satisfies StreamMessage;
        }
        liveSent.set(update.segmentId, update.text.length);
      }
    }

    // ---- the live tail ----
    const visibleProjects = new Map<ProjectId, boolean>();
    const canSee = async (projectId: ProjectId): Promise<boolean> => {
      const known = visibleProjects.get(projectId);
      if (known !== undefined) {
        return known;
      }
      const row = await db.project.findFirst({ where: { id: projectId, organizationId: scope.organizationId }, select: { access: true } });
      const visible = row !== null && requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: row.access }, "read").ok;
      visibleProjects.set(projectId, visible);
      return visible;
    };

    let nextCheck = Date.now() + recheckMs;
    while (!abort.aborted) {
      const result = await queue.next(abort, Math.max(1, nextCheck - Date.now()));
      if (queue.overflowed()) {
        // A viewer that can't keep up reconnects and resumes by seq (ADR 0035).
        // A retryable code: tRPC's client reconnects on it, and resumes from the last tracked id.
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "The stream fell behind: reconnecting to resume" });
      }
      if (result.kind === "aborted") {
        return;
      }

      if (Date.now() >= nextCheck) {
        // An open SSE response outlives a revoked session or membership: look again.
        const member = await ctx.revalidate();
        if (member?.scope.organizationId !== scope.organizationId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "You are no longer a member of this organization" });
        }
        scope = member.scope;
        visibleProjects.clear();
        if (taskProjectId !== null) {
          await loadProjectAccess(db, scope, taskProjectId, "read").catch(() => {
            throw new TRPCError({ code: "FORBIDDEN", message: "You may no longer open this task" });
          });
        }
        nextCheck = Date.now() + recheckMs;
      }
      if (result.kind === "timeout") {
        continue;
      }

      const item = result.item;
      switch (item.kind) {
        case "events":
          for (const event of item.events) {
            // A seq the catch-up already sent is never sent twice.
            if (event.seq <= lastSeq || input.taskId === undefined) {
              continue;
            }
            lastSeq = event.seq;
            yield tracked(String(event.seq), { type: "event", event } satisfies StreamMessage);
          }
          break;
        case "live": {
          const taskId = input.taskId;
          if (taskId === undefined) {
            break;
          }
          for (const update of item.updates) {
            const sent = liveSent.get(update.segmentId);
            const delta = !update.reset && sent !== undefined && sent === update.previousLength;
            for (const frame of liveFrames(taskId, update, delta ? sent : 0, delta ? update.text.slice(sent) : update.text)) {
              yield { type: "live", frame } satisfies StreamMessage;
            }
            liveSent.set(update.segmentId, update.text.length);
          }
          for (const segmentId of item.ended) {
            liveSent.delete(segmentId);
            yield { type: "live-end", segmentId } satisfies StreamMessage;
          }
          break;
        }
        case "changes":
          for (const notice of item.notices) {
            if (notice.organizationId !== scope.organizationId) {
              continue;
            }
            const visible = notice.projectId === null ? true : await canSee(notice.projectId);
            if (!visible) {
              continue;
            }
            yield { type: "change", entity: notice.entity, entityId: notice.entityId, projectId: notice.projectId } satisfies StreamMessage;
          }
          break;
        default:
          item satisfies never;
      }
    }
  } finally {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  }
}
