import { z } from "zod";
import type { TaskInfo } from "../shared/api.ts";
import { liveFrame, storedEventSchema, type StoredEvent } from "../shared/events.ts";
import type { LiveText } from "../shared/fold.ts";
import type { SegmentId, TaskId } from "../shared/ids.ts";
import { api } from "./api.ts";

export type StreamStatus = "loading" | "live" | "reconnecting" | "error";

export type StreamSnapshot = {
  readonly status: StreamStatus;
  readonly events: readonly StoredEvent[];
  readonly live: readonly LiveText[];
  readonly info: TaskInfo | null;
  readonly hasEarlier: boolean;
  readonly oldestSeq: number;
  readonly version: number;
};

export type StreamCounters = {
  eventsReceived: number;
  liveFrames: number;
  liveIgnored: number;
  gaps: number;
  duplicates: number;
  invalidFrames: number;
  // errors the browser's own EventSource reported (it reconnects by itself)
  reconnects: number;
  // times the page's watchdog gave up on a connection that went silent and opened a new one
  watchdogReconnects: number;
};

// The server sends a named `ping` event every 15 s. If the page has seen no frame of any kind (event, live
// or ping) for this long, the connection is treated as dead: a black-holed network (a NAT that forgot the
// flow, a laptop that slept) leaves the socket open and the EventSource silent, and it never says so.
export const WATCHDOG_MS = 20_000;
const WATCHDOG_CHECK_MS = 2000;

export type TaskStream = {
  readonly counters: StreamCounters;
  readonly seenSeqs: number[];
  readonly timing: { infoAt: number | null; historyAt: number | null; flushMs: number };
  readonly liveLog: { at: number; segmentId: SegmentId; offset: number; length: number }[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => StreamSnapshot;
  readonly start: () => Promise<void>;
  readonly loadEarlier: () => Promise<void>;
  readonly stop: () => void;
};

const parseData = (data: unknown): unknown => {
  const text = z.string().safeParse(data);
  if (!text.success) return undefined;
  try {
    return JSON.parse(text.data);
  } catch {
    return undefined;
  }
};

// The page's side of ostra's own SSE stream. It loads history by turn, then tails from the newest
// seq with `lastEventId`; a dropped stream reconnects by itself and resumes from the last id.
// Every committed event is checked for contiguity: a gap or a duplicate is counted, never hidden.
export const createTaskStream = (taskId: TaskId, turns: string): TaskStream => {
  const counters: StreamCounters = {
    eventsReceived: 0,
    liveFrames: 0,
    liveIgnored: 0,
    gaps: 0,
    duplicates: 0,
    invalidFrames: 0,
    reconnects: 0,
    watchdogReconnects: 0,
  };
  let snapshot: StreamSnapshot = {
    status: "loading",
    events: [],
    live: [],
    info: null,
    hasEarlier: false,
    oldestSeq: 1,
    version: 0,
  };
  const listeners = new Set<() => void>();
  const liveMap = new Map<SegmentId, LiveText>();
  const seenSeqs: number[] = [];
  const timing: { infoAt: number | null; historyAt: number | null; flushMs: number } = { infoAt: null, historyAt: null, flushMs: 0 };
  const liveLog: { at: number; segmentId: SegmentId; offset: number; length: number }[] = [];
  let buffer: StoredEvent[] = [];
  let lastSeq = 0;
  let source: EventSource | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastFrameAt = performance.now();
  let liveDirty = false;

  const emit = (patch: Partial<StreamSnapshot>): void => {
    snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 };
    for (const listener of listeners) listener();
  };

  const checkContiguous = (events: readonly StoredEvent[]): void => {
    let previous: number | null = null;
    for (const { seq } of events) {
      if (previous !== null && seq !== previous + 1) counters.gaps += 1;
      previous = seq;
    }
  };

  // How long the page took to fold and lay out the last flush, as seen on the next animation frame. Under a
  // heavy stream the next flush waits twice that long (16 ms at least, 250 ms at most), so the page batches more
  // instead of re-folding the whole log faster than it can draw it.
  let lastCostMs = 0;

  const flush = (): void => {
    const patch: { events?: readonly StoredEvent[]; live?: readonly LiveText[] } = {};
    if (buffer.length > 0) {
      patch.events = snapshot.events.concat(buffer);
      buffer = [];
    }
    if (liveDirty) {
      patch.live = [...liveMap.values()];
      liveDirty = false;
    }
    const started = performance.now();
    emit(patch);
    requestAnimationFrame(() => {
      lastCostMs = performance.now() - started;
      timing.flushMs = lastCostMs;
    });
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, Math.min(250, Math.max(16, lastCostMs * 2)));
  };

  const onEvent = (data: unknown): void => {
    lastFrameAt = performance.now();
    const json = parseData(data);
    const parsed = storedEventSchema.safeParse(json);
    if (!parsed.success) {
      counters.invalidFrames += 1;
      return;
    }
    const event = parsed.data;
    counters.eventsReceived += 1;
    seenSeqs.push(event.seq);
    if (event.seq <= lastSeq) {
      counters.duplicates += 1;
      return;
    }
    if (event.seq !== lastSeq + 1) counters.gaps += 1;
    lastSeq = event.seq;
    buffer.push(event);
    const kind = event.event.kind;
    if (kind === "agent.message" || kind === "agent.thought") {
      liveMap.delete(event.event.segmentId);
      liveDirty = true;
    }
    scheduleFlush();
  };

  const onLive = (data: unknown): void => {
    lastFrameAt = performance.now();
    const parsed = liveFrame.safeParse(parseData(data));
    if (!parsed.success) {
      counters.invalidFrames += 1;
      return;
    }
    const frame = parsed.data;
    counters.liveFrames += 1;
    const current = liveMap.get(frame.segmentId);
    if (frame.offset === 0) {
      liveMap.set(frame.segmentId, { segmentId: frame.segmentId, turnId: frame.turnId, part: frame.part, text: frame.text });
    } else if (current?.text.length === frame.offset) {
      liveMap.set(frame.segmentId, { ...current, text: current.text + frame.text });
    } else {
      // A delta that does not line up is ignored until the next snapshot (offset 0).
      counters.liveIgnored += 1;
      return;
    }
    liveLog.push({ at: performance.now(), segmentId: frame.segmentId, offset: frame.offset, length: liveMap.get(frame.segmentId)?.text.length ?? 0 });
    liveDirty = true;
    scheduleFlush();
  };

  const open = (): void => {
    // The first connect passes the history's head. After a drop, the browser resends the id of
    // the last event it saw as `Last-Event-ID`, which the server reads first. A connection the watchdog
    // opens again passes the newest committed seq the page holds.
    const next = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/stream?lastEventId=${String(lastSeq)}`);
    source = next;
    lastFrameAt = performance.now();
    next.addEventListener("open", () => {
      lastFrameAt = performance.now();
      emit({ status: "live" });
    });
    next.addEventListener("error", () => {
      counters.reconnects += 1;
      emit({ status: next.readyState === EventSource.CLOSED ? "error" : "reconnecting" });
    });
    next.addEventListener("event", (message) => {
      onEvent(message.data);
    });
    next.addEventListener("live", (message) => {
      onLive(message.data);
    });
    next.addEventListener("ping", () => {
      lastFrameAt = performance.now();
    });
  };

  const startWatchdog = (): void => {
    if (watchdog !== null) return;
    watchdog = setInterval(() => {
      if (source === null || performance.now() - lastFrameAt < WATCHDOG_MS) return;
      counters.watchdogReconnects += 1;
      source.close();
      emit({ status: "reconnecting" });
      open();
    }, WATCHDOG_CHECK_MS);
  };

  return {
    counters,
    seenSeqs,
    timing,
    liveLog,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    start: async () => {
      const info = await api.task(taskId);
      timing.infoAt = performance.now();
      const page = await api.history(taskId, turns);
      timing.historyAt = performance.now();
      checkContiguous(page.events);
      lastSeq = page.headSeq;
      emit({
        info,
        events: page.events,
        hasEarlier: page.hasEarlier,
        oldestSeq: page.oldestSeq,
        status: "loading",
      });
      open();
      startWatchdog();
    },
    loadEarlier: async () => {
      const before = snapshot.oldestSeq;
      if (!snapshot.hasEarlier) return;
      const page = await api.history(taskId, turns, before);
      emit({
        events: [...page.events, ...snapshot.events],
        hasEarlier: page.hasEarlier,
        oldestSeq: page.oldestSeq,
      });
    },
    stop: () => {
      source?.close();
      source = null;
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      if (watchdog !== null) clearInterval(watchdog);
      watchdog = null;
    },
  };
};
