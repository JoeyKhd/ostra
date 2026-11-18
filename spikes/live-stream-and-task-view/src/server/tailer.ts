import { z } from "zod";
import type { TailerCounters } from "../shared/api.ts";
import { SegmentId, TaskId, TurnId } from "../shared/ids.ts";
import { rows, type Db } from "./db.ts";
import type { Logger } from "./log.ts";
import type { WakeItem } from "./appender.ts";

// One tailer per replica (ADR 0035). On a wake-up, or on a poll about every 250 ms, one query reads
// `seq > cursor` for the tasks that have watchers. Query count scales with notifications, not with watchers.

export type LiveUpdate = {
  readonly segmentId: SegmentId;
  readonly turnId: TurnId;
  readonly part: "message" | "thought";
  readonly text: string;
  // The length of the segment's text the tailer had before this update. A subscriber that has sent
  // exactly that much can send a delta; otherwise it sends a snapshot.
  readonly previousLength: number;
  readonly reset: boolean;
};

export type Delivery = {
  readonly events: readonly { readonly seq: number; readonly sse: string }[];
  readonly live: readonly LiveUpdate[];
};

export type Subscriber = {
  readonly deliver: (delivery: Delivery) => void;
};

type LiveSegment = { turnId: TurnId; part: "message" | "thought"; text: string };

type Group = {
  taskId: TaskId;
  cursor: number;
  subscribers: Set<Subscriber>;
  live: Map<SegmentId, LiveSegment>;
  dirtyEvents: boolean;
  dirtyLive: boolean;
};

const eventRow = z.object({
  task_id: TaskId,
  seq: z.coerce.number(),
  at_ms: z.coerce.number(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

const liveRow = z.object({
  task_id: TaskId,
  segment_id: SegmentId,
  turn_id: TurnId,
  part: z.enum(["message", "thought"]),
  text: z.string(),
});

const headRow = z.object({ head: z.coerce.number() });

export const sseEvent = (seq: number, at: number, kind: string, payload: Record<string, unknown>): string =>
  `id: ${String(seq)}\nevent: event\ndata: ${JSON.stringify({ seq, at, event: { kind, ...payload } })}\n\n`;

export type Tailer = {
  readonly metrics: TailerCounters;
  readonly start: () => void;
  readonly stop: () => void;
  // A commit happened (here or on another replica). Only a wake-up: it carries no content.
  readonly wake: (items: readonly WakeItem[]) => void;
  readonly markAllDirty: () => void;
  // Registers the subscriber before the caller catches up from the table, so nothing slips through.
  // `startCursor` is the newest seq the tailer will NOT deliver to this subscriber.
  readonly subscribe: (taskId: TaskId, subscriber: Subscriber) => Promise<{ startCursor: number; liveSnapshot: readonly LiveUpdate[] }>;
  readonly unsubscribe: (taskId: TaskId, subscriber: Subscriber) => void;
  readonly subscriberCount: () => number;
  readonly groupCount: () => number;
};

export const createTailer = (db: Db, pollMs: number, log: Logger): Tailer => {
  const metrics: TailerCounters = {
    ticks: 0,
    eventQueries: 0,
    liveQueries: 0,
    eventRows: 0,
    wakes: 0,
    polls: 0,
    maxSubscribers: 0,
  };
  const groups = new Map<TaskId, Group>();
  const creating = new Map<TaskId, Promise<Group>>();
  let timer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let running = false;
  let tickInFlight = false;
  let rerun = false;

  const subscriberCount = (): number => {
    let n = 0;
    for (const group of groups.values()) n += group.subscribers.size;
    return n;
  };

  const createGroup = async (taskId: TaskId): Promise<Group> => {
    const head = await rows(db, headRow, "SELECT COALESCE(max(next_seq) - 1, 0) AS head FROM task_counters WHERE task_id = $1", [taskId]);
    const live = new Map<SegmentId, LiveSegment>();
    const liveRows = await rows(db, liveRow, "SELECT task_id, segment_id, turn_id, part, text FROM task_live_text WHERE task_id = $1", [taskId]);
    for (const row of liveRows) live.set(row.segment_id, { turnId: row.turn_id, part: row.part, text: row.text });
    return {
      taskId,
      cursor: head[0]?.head ?? 0,
      subscribers: new Set(),
      live,
      dirtyEvents: false,
      dirtyLive: false,
    };
  };

  const markDirty = (): void => {
    for (const group of groups.values()) {
      group.dirtyEvents = true;
      group.dirtyLive = true;
    }
  };

  const readEvents = async (): Promise<void> => {
    for (let page = 0; page < 50; page += 1) {
      const dirty: Group[] = [];
      for (const group of groups.values()) {
        if (group.dirtyEvents) dirty.push(group);
      }
      if (dirty.length === 0) return;
      for (const group of dirty) group.dirtyEvents = false;
      const LIMIT = 20_000;
      const result = await rows(
        db,
        eventRow,
        `SELECT e.task_id, e.seq, e.at_ms, e.kind, e.payload
         FROM events e JOIN unnest($1::text[], $2::bigint[]) AS c(task_id, cursor)
           ON e.task_id = c.task_id AND e.seq > c.cursor
         ORDER BY e.task_id, e.seq LIMIT ${String(LIMIT)}`,
        [dirty.map((g) => g.taskId), dirty.map((g) => g.cursor)],
      );
      metrics.eventQueries += 1;
      metrics.eventRows += result.length;
      const perTask = new Map<TaskId, { seq: number; sse: string }[]>();
      for (const row of result) {
        let list = perTask.get(row.task_id);
        if (list === undefined) {
          list = [];
          perTask.set(row.task_id, list);
        }
        list.push({ seq: row.seq, sse: sseEvent(row.seq, row.at_ms, row.kind, row.payload) });
      }
      for (const group of dirty) {
        const list = perTask.get(group.taskId);
        if (list === undefined || list.length === 0) continue;
        const last = list[list.length - 1];
        if (last !== undefined) group.cursor = last.seq;
        for (const subscriber of group.subscribers) subscriber.deliver({ events: list, live: [] });
      }
      if (result.length >= LIMIT) {
        // more to read: mark everything we just served as dirty again
        for (const group of dirty) group.dirtyEvents = true;
        continue;
      }
      return;
    }
  };

  const readLive = async (): Promise<void> => {
    const dirty: Group[] = [];
    for (const group of groups.values()) {
      if (group.dirtyLive) dirty.push(group);
    }
    if (dirty.length === 0) return;
    for (const group of dirty) group.dirtyLive = false;
    const result = await rows(
      db,
      liveRow,
      "SELECT task_id, segment_id, turn_id, part, text FROM task_live_text WHERE task_id = ANY($1::text[])",
      [dirty.map((g) => g.taskId)],
    );
    metrics.liveQueries += 1;
    const seen = new Map<TaskId, Set<SegmentId>>();
    const updates = new Map<TaskId, LiveUpdate[]>();
    for (const row of result) {
      const group = groups.get(row.task_id);
      if (group === undefined) continue;
      let ids = seen.get(row.task_id);
      if (ids === undefined) {
        ids = new Set();
        seen.set(row.task_id, ids);
      }
      ids.add(row.segment_id);
      const cached = group.live.get(row.segment_id);
      if (cached?.text === row.text) continue;
      const previousLength = cached?.text.length ?? 0;
      const reset = cached === undefined || !row.text.startsWith(cached.text);
      group.live.set(row.segment_id, { turnId: row.turn_id, part: row.part, text: row.text });
      let list = updates.get(row.task_id);
      if (list === undefined) {
        list = [];
        updates.set(row.task_id, list);
      }
      list.push({
        segmentId: row.segment_id,
        turnId: row.turn_id,
        part: row.part,
        text: row.text,
        previousLength: reset ? 0 : previousLength,
        reset,
      });
    }
    for (const group of dirty) {
      // a segment missing from the table was completed (or cleaned up): forget it
      const ids = seen.get(group.taskId);
      for (const segmentId of [...group.live.keys()]) {
        if (!ids?.has(segmentId)) group.live.delete(segmentId);
      }
      const list = updates.get(group.taskId);
      if (list === undefined) continue;
      for (const subscriber of group.subscribers) subscriber.deliver({ events: [], live: list });
    }
  };

  const schedule = (): void => {
    if (!running || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, 2);
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      rerun = true;
      return;
    }
    tickInFlight = true;
    metrics.ticks += 1;
    try {
      await readEvents();
      await readLive();
    } catch (error) {
      log.error("tailer.tick_failed", { name: error instanceof Error ? error.name : "unknown" });
      // try again on the next poll
      markDirty();
    } finally {
      tickInFlight = false;
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  };

  return {
    metrics,
    start: () => {
      running = true;
      pollTimer = setInterval(() => {
        metrics.polls += 1;
        markDirty();
        schedule();
      }, pollMs);
    },
    stop: () => {
      running = false;
      if (pollTimer !== null) clearInterval(pollTimer);
      if (timer !== null) clearTimeout(timer);
      pollTimer = null;
      timer = null;
    },
    wake: (items) => {
      metrics.wakes += 1;
      for (const item of items) {
        const group = groups.get(item.taskId);
        if (group === undefined) continue;
        if (item.seq > group.cursor) group.dirtyEvents = true;
        if (item.live) group.dirtyLive = true;
      }
      schedule();
    },
    markAllDirty: () => {
      markDirty();
      schedule();
    },
    subscribe: async (taskId, subscriber) => {
      let group = groups.get(taskId);
      if (group === undefined) {
        let pending = creating.get(taskId);
        if (pending === undefined) {
          pending = createGroup(taskId);
          creating.set(taskId, pending);
        }
        try {
          group = await pending;
        } finally {
          creating.delete(taskId);
        }
        const existing = groups.get(taskId);
        if (existing === undefined) groups.set(taskId, group);
        else group = existing;
      }
      group.subscribers.add(subscriber);
      metrics.maxSubscribers = Math.max(metrics.maxSubscribers, subscriberCount());
      const liveSnapshot: LiveUpdate[] = [];
      for (const [segmentId, segment] of group.live) {
        liveSnapshot.push({
          segmentId,
          turnId: segment.turnId,
          part: segment.part,
          text: segment.text,
          previousLength: 0,
          reset: true,
        });
      }
      return { startCursor: group.cursor, liveSnapshot };
    },
    unsubscribe: (taskId, subscriber) => {
      const group = groups.get(taskId);
      if (group === undefined) return;
      group.subscribers.delete(subscriber);
      if (group.subscribers.size === 0) groups.delete(taskId);
    },
    subscriberCount,
    groupCount: () => groups.size,
  };
};
