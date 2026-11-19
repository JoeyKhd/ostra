import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { notifyChannels } from "@ostra/db";
import { changeEntitySchema, organizationIdSchema, projectIdSchema, segmentIdSchema, sessionIdSchema, storedEventSchema, taskIdSchema, turnIdSchema } from "@ostra/protocol";
import type { ChangeEntity, OrganizationId, ProjectId, SegmentId, SessionId, StoredEvent, TaskId, TurnId } from "@ostra/protocol";
import pg from "pg";
import { z } from "zod";

// Ported from spikes/live-stream-and-task-view/src/server/tailer.ts and wake.ts (spike 7, ADR 0035).
//
// One hub per web process. It holds one dedicated `LISTEN` connection and wakes on core's `NOTIFY`
// (the panel's own writes send one too), and polls about every 250 ms when none arrives, so a lost
// wake-up costs latency, never data. On a wake-up one query reads `seq > cursor` across the tasks
// it has watchers on, and one reads the change notices: query count scales with notifications, not
// with watchers. A wake-up carries IDs only and is never content (ADR 0035).

/** The newest text of one open segment, and how a viewer that has the previous text catches up. */
export type LiveUpdate = {
  readonly segmentId: SegmentId;
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly kind: "message" | "thought";
  /** The segment's whole text so far. */
  readonly text: string;
  /** The text's length the hub had before this update; a viewer holding exactly that much gets a delta. */
  readonly previousLength: number;
  /** The text isn't an extension of the previous one: send a snapshot. */
  readonly reset: boolean;
};

/** A change to tell the panel's live views about: IDs only (ADR 0035). */
export type ChangeNoticeRow = {
  readonly seq: number;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId | null;
  readonly entity: ChangeEntity;
  readonly entityId: string;
};

/** Receives what the hub reads for one watched task. Called on the hub's tick: it must not throw or wait. */
export type TaskSubscriber = {
  /** Committed events newer than the subscription's start cursor, in order. */
  readonly deliverEvents: (events: readonly StoredEvent[]) => void;
  /** Changed partial text, and segments whose partial text is gone (completed or abandoned). */
  readonly deliverLive: (updates: readonly LiveUpdate[], ended: readonly SegmentId[]) => void;
};

export type ChangeSubscriber = {
  readonly deliverChanges: (notices: readonly ChangeNoticeRow[]) => void;
};

export type TaskSubscription = {
  /** The newest seq the hub will not deliver to this subscriber: catch up from the table up to it. */
  readonly startCursor: number;
  /** The open segments' partial text at subscription time. */
  readonly liveSnapshot: readonly LiveUpdate[];
  readonly unsubscribe: () => void;
};

export type HubMetrics = {
  ticks: number;
  eventQueries: number;
  liveQueries: number;
  changeQueries: number;
  eventRows: number;
  wakes: number;
  polls: number;
};

export type StreamHub = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  /** Registers the subscriber before the caller catches up from the table, so nothing slips through. */
  readonly subscribeTask: (taskId: TaskId, subscriber: TaskSubscriber) => Promise<TaskSubscription>;
  readonly subscribeChanges: (subscriber: ChangeSubscriber) => Promise<() => void>;
  readonly metrics: () => Readonly<HubMetrics>;
  readonly subscriberCount: () => number;
};

export type CreateStreamHubInput = {
  readonly db: Db;
  /** For the dedicated `LISTEN` connection. Holds credentials: never logged. */
  readonly databaseUrl: string;
  readonly logger: Logger;
  /** The poll interval when no wake-up arrives. Default 250 ms (ADR 0035, a working value). */
  readonly pollMs?: number;
};

const eventRowSchema = z.object({
  taskId: taskIdSchema,
  seq: z.number().int(),
  sessionId: sessionIdSchema,
  sessionSeq: z.number().int().nullable(),
  occurredAt: z.coerce.date(),
  payload: z.unknown(),
});

const liveRowSchema = z.object({
  taskId: taskIdSchema,
  segmentId: segmentIdSchema,
  sessionId: sessionIdSchema,
  turnId: turnIdSchema,
  kind: z.enum(["message", "thought"]),
  text: z.string(),
});

const EVENT_READ_LIMIT = 20_000;
const NOTICE_READ_LIMIT = 1000;

type LiveSegment = { turnId: TurnId; sessionId: SessionId; kind: "message" | "thought"; text: string };

type Group = {
  readonly taskId: TaskId;
  cursor: number;
  readonly subscribers: Set<TaskSubscriber>;
  readonly live: Map<SegmentId, LiveSegment>;
  dirtyEvents: boolean;
  dirtyLive: boolean;
};

/** Reads an event row from the raw query into the shape the panel reads. */
export const parseEventRow = (row: unknown): StoredEvent => {
  const parsed = eventRowSchema.parse(row);
  return storedEventSchema.parse({
    taskId: parsed.taskId,
    seq: parsed.seq,
    sessionId: parsed.sessionId,
    sessionSeq: parsed.sessionSeq,
    at: parsed.occurredAt.getTime(),
    event: parsed.payload,
  });
};

const notificationSchema = z.looseObject({ taskId: z.string().optional() });

export const createStreamHub = (input: CreateStreamHubInput): StreamHub => {
  const { db, logger } = input;
  const pollMs = input.pollMs ?? 250;
  const metrics: HubMetrics = { ticks: 0, eventQueries: 0, liveQueries: 0, changeQueries: 0, eventRows: 0, wakes: 0, polls: 0 };
  const groups = new Map<TaskId, Group>();
  const creating = new Map<TaskId, Promise<Group>>();
  const changeSubscribers = new Set<ChangeSubscriber>();
  let changeCursor = 0;
  let dirtyChanges = false;

  let running = false;
  let tickInFlight = false;
  let rerun = false;
  let scheduled: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  let listener: pg.Client | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const subscriberCount = (): number => {
    let count = changeSubscribers.size;
    for (const group of groups.values()) {
      count += group.subscribers.size;
    }
    return count;
  };

  const readLiveRows = async (taskIds: readonly string[]) => {
    const rows: unknown = await db.$queryRaw`
      SELECT "taskId", "segmentId", "sessionId", "turnId", "kind", "text"
      FROM "ostra_live"."live_text" WHERE "taskId" = ANY(${taskIds}::text[])`;
    return z.array(liveRowSchema).parse(rows);
  };

  const createGroup = async (taskId: TaskId): Promise<Group> => {
    const task = await db.task.findUnique({ where: { id: taskId }, select: { eventSeq: true } });
    const live = new Map<SegmentId, LiveSegment>();
    for (const row of await readLiveRows([taskId])) {
      live.set(row.segmentId, {
        turnId: row.turnId,
        sessionId: row.sessionId,
        kind: row.kind,
        text: row.text,
      });
    }
    return {
      taskId,
      cursor: task?.eventSeq ?? 0,
      subscribers: new Set(),
      live,
      dirtyEvents: false,
      dirtyLive: false,
    };
  };

  const markAllDirty = (): void => {
    for (const group of groups.values()) {
      group.dirtyEvents = true;
      group.dirtyLive = true;
    }
    dirtyChanges = true;
  };

  const readEvents = async (): Promise<void> => {
    // A page of rows can end inside one task's events; every task served is marked dirty again then.
    for (let page = 0; page < 50; page += 1) {
      const dirty = [...groups.values()].filter((group) => group.dirtyEvents);
      if (dirty.length === 0) {
        return;
      }
      for (const group of dirty) {
        group.dirtyEvents = false;
      }
      const taskIds = dirty.map((group) => group.taskId);
      const cursors = dirty.map((group) => group.cursor);
      const rows: unknown = await db.$queryRaw`
        SELECT e."taskId", e."seq", e."sessionId", e."sessionSeq", e."occurredAt", e."payload"
        FROM "event" e
        JOIN unnest(${taskIds}::text[], ${cursors}::int[]) AS c(task_id, cursor)
          ON e."taskId" = c.task_id AND e."seq" > c.cursor
        ORDER BY e."taskId", e."seq"
        LIMIT ${EVENT_READ_LIMIT}`;
      metrics.eventQueries += 1;
      const events = z.array(z.unknown()).parse(rows).map(parseEventRow);
      metrics.eventRows += events.length;
      const perTask = new Map<TaskId, StoredEvent[]>();
      for (const event of events) {
        const list = perTask.get(event.taskId) ?? [];
        list.push(event);
        perTask.set(event.taskId, list);
      }
      for (const group of dirty) {
        const list = perTask.get(group.taskId);
        const last = list?.at(-1);
        if (list === undefined || last === undefined) {
          continue;
        }
        group.cursor = last.seq;
        for (const subscriber of group.subscribers) {
          subscriber.deliverEvents(list);
        }
      }
      if (events.length < EVENT_READ_LIMIT) {
        return;
      }
      for (const group of dirty) {
        group.dirtyEvents = true;
      }
    }
  };

  const readLive = async (): Promise<void> => {
    const dirty = [...groups.values()].filter((group) => group.dirtyLive);
    if (dirty.length === 0) {
      return;
    }
    for (const group of dirty) {
      group.dirtyLive = false;
    }
    const rows = await readLiveRows(dirty.map((group) => group.taskId));
    metrics.liveQueries += 1;
    const seen = new Map<TaskId, Set<SegmentId>>();
    const updates = new Map<TaskId, LiveUpdate[]>();
    for (const row of rows) {
      const group = groups.get(row.taskId);
      if (group === undefined) {
        continue;
      }
      const segmentId = row.segmentId;
      const ids = seen.get(row.taskId) ?? new Set<SegmentId>();
      ids.add(segmentId);
      seen.set(row.taskId, ids);
      const cached = group.live.get(segmentId);
      if (cached?.text === row.text) {
        continue;
      }
      const reset = cached === undefined || !row.text.startsWith(cached.text);
      const next: LiveSegment = {
        turnId: row.turnId,
        sessionId: row.sessionId,
        kind: row.kind,
        text: row.text,
      };
      group.live.set(segmentId, next);
      const list = updates.get(row.taskId) ?? [];
      list.push({ segmentId, ...next, previousLength: reset ? 0 : cached.text.length, reset });
      updates.set(row.taskId, list);
    }
    for (const group of dirty) {
      // A segment missing from the table was completed (its message committed) or abandoned.
      const present = seen.get(group.taskId);
      const ended: SegmentId[] = [];
      for (const segmentId of [...group.live.keys()]) {
        if (present?.has(segmentId) !== true) {
          group.live.delete(segmentId);
          ended.push(segmentId);
        }
      }
      const list = updates.get(group.taskId) ?? [];
      if (list.length === 0 && ended.length === 0) {
        continue;
      }
      for (const subscriber of group.subscribers) {
        subscriber.deliverLive(list, ended);
      }
    }
  };

  const readChanges = async (): Promise<void> => {
    if (!dirtyChanges || changeSubscribers.size === 0) {
      return;
    }
    dirtyChanges = false;
    for (let page = 0; page < 20; page += 1) {
      const rows = await db.changeNotice.findMany({
        where: { seq: { gt: changeCursor } },
        orderBy: { seq: "asc" },
        take: NOTICE_READ_LIMIT,
        select: { seq: true, organizationId: true, projectId: true, entity: true, entityId: true },
      });
      metrics.changeQueries += 1;
      const last = rows.at(-1);
      if (last === undefined) {
        return;
      }
      changeCursor = Number(last.seq);
      const notices: ChangeNoticeRow[] = [];
      for (const row of rows) {
        // A kind this version doesn't know (a row from a newer core) is skipped, not delivered as a string.
        const entity = changeEntitySchema.safeParse(row.entity);
        if (!entity.success) {
          logger.warn("stream.change_notice_unknown_entity", { seq: Number(row.seq) });
          continue;
        }
        notices.push({
          seq: Number(row.seq),
          organizationId: organizationIdSchema.parse(row.organizationId),
          projectId: row.projectId === null ? null : projectIdSchema.parse(row.projectId),
          entity: entity.data,
          entityId: row.entityId,
        });
      }
      if (notices.length > 0) {
        for (const subscriber of changeSubscribers) {
          subscriber.deliverChanges(notices);
        }
      }
      if (rows.length < NOTICE_READ_LIMIT) {
        return;
      }
    }
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
      await readChanges();
    } catch (error) {
      logger.error("stream.tick_failed", { reason: error instanceof Error ? error.name : "unknown" });
      // Everything is read again on the next poll: a failed tick costs latency, never data.
      markAllDirty();
    } finally {
      tickInFlight = false;
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (!running || scheduled !== null) {
      return;
    }
    scheduled = setTimeout(() => {
      scheduled = null;
      void tick();
    }, 2);
  };

  // ---- the dedicated LISTEN connection (ADR 0034) ----

  const onNotification = (channel: string, payload: string | undefined): void => {
    metrics.wakes += 1;
    if (channel === notifyChannels.changes) {
      dirtyChanges = true;
      schedule();
      return;
    }
    if (channel !== notifyChannels.taskEvents) {
      return;
    }
    // A wake-up names a task and its newest seq. One that can't be read wakes every watched task.
    let taskId: string | undefined;
    try {
      const parsed = notificationSchema.safeParse(JSON.parse(payload ?? "{}"));
      taskId = parsed.success ? parsed.data.taskId : undefined;
    } catch {
      taskId = undefined;
    }
    for (const group of groups.values()) {
      if (taskId === undefined || group.taskId === taskId) {
        group.dirtyEvents = true;
        // Partial text is flushed at its own rhythm and has no wake-up: a task that moved is read for it too.
        group.dirtyLive = true;
      }
    }
    schedule();
  };

  const connectListener = async (): Promise<void> => {
    const client = new pg.Client({ connectionString: input.databaseUrl });
    client.on("notification", (message) => {
      onNotification(message.channel, message.payload);
    });
    client.on("error", () => {
      logger.warn("stream.listen_error");
      reconnect();
    });
    client.on("end", () => {
      reconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${notifyChannels.taskEvents}`);
    await client.query(`LISTEN ${notifyChannels.changes}`);
    listener = client;
  };

  const reconnect = (): void => {
    if (!running || reconnectTimer !== null) {
      return;
    }
    const old = listener;
    listener = null;
    if (old !== null) {
      void old.end().catch(() => undefined);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectListener()
        .then(() => {
          // Whatever committed while the connection was down is read now.
          markAllDirty();
          schedule();
        })
        .catch(() => {
          reconnect();
        });
    }, 500);
  };

  return {
    metrics: () => metrics,
    subscriberCount,
    start: async () => {
      running = true;
      await connectListener();
      pollTimer = setInterval(() => {
        metrics.polls += 1;
        markAllDirty();
        schedule();
      }, pollMs);
    },
    stop: async () => {
      running = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
      }
      if (scheduled !== null) {
        clearTimeout(scheduled);
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      pollTimer = null;
      scheduled = null;
      reconnectTimer = null;
      const current = listener;
      listener = null;
      if (current !== null) {
        await current.end().catch(() => undefined);
      }
    },
    subscribeTask: async (taskId, subscriber) => {
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
        // Two openers can create the group at once: the first to finish wins, both use it.
        const existing = groups.get(taskId);
        if (existing === undefined) {
          groups.set(taskId, group);
        } else {
          group = existing;
        }
      }
      group.subscribers.add(subscriber);
      const liveSnapshot: LiveUpdate[] = [...group.live].map(([segmentId, segment]) => ({
        segmentId,
        ...segment,
        previousLength: 0,
        reset: true,
      }));
      const joined = group;
      return {
        startCursor: joined.cursor,
        liveSnapshot,
        unsubscribe: () => {
          joined.subscribers.delete(subscriber);
          if (joined.subscribers.size === 0 && groups.get(taskId) === joined) {
            groups.delete(taskId);
          }
        },
      };
    },
    subscribeChanges: async (subscriber) => {
      if (changeSubscribers.size === 0) {
        // The first watcher starts at the newest notice: older ones are history a refetch covers.
        const newest = await db.changeNotice.aggregate({ _max: { seq: true } });
        changeCursor = Number(newest._max.seq ?? 0);
      }
      changeSubscribers.add(subscriber);
      return () => {
        changeSubscribers.delete(subscriber);
      };
    },
  };
};
