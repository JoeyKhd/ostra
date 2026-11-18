import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { SseMetrics } from "../shared/api.ts";
import type { SegmentId, TaskId } from "../shared/ids.ts";
import { rows, type Db } from "./db.ts";
import type { Delivery, LiveUpdate, Subscriber, Tailer } from "./tailer.ts";
import { sseEvent } from "./tailer.ts";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const CATCHUP_PAGE = 2000;

const catchupRow = z.object({
  seq: z.coerce.number(),
  at_ms: z.coerce.number(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export const createSseMetrics = (): SseMetrics => ({ opened: 0, closed: 0, active: 0, slowDisconnects: 0, framesWritten: 0 });

// A keepalive the page can see. An SSE comment (`: ping`) never reaches an EventSource's JavaScript, so a
// page could not tell a quiet task from a dead connection. A named event it can: the page's watchdog
// reconnects when it has seen no frame of any kind for 20 s.
export const PING_FRAME = "event: ping\ndata: {}\n\n";

const liveFrameText = (update: LiveUpdate, offset: number, text: string): string =>
  `event: live\ndata: ${JSON.stringify({
    segmentId: update.segmentId,
    turnId: update.turnId,
    part: update.part,
    offset,
    text,
  })}\n\n`;

export type SseConnection = Subscriber & {
  readonly isClosed: () => boolean;
  readonly write: (text: string) => boolean;
  // Replay committed events with seq in (from, to], then drain what the tailer queued meanwhile.
  readonly catchUp: (db: Db, taskId: TaskId, from: number, to: number, liveSnapshot: readonly LiveUpdate[]) => Promise<void>;
  readonly close: () => void;
};

// One browser stream. Committed events go out with `id: <seq>` so a dropped stream resumes from
// `Last-Event-ID`. Live frames carry no id, so they never move the resume point.
export const createSseConnection = (res: ServerResponse, lastEventId: number, metrics: SseMetrics): SseConnection => {
  let caughtUp = false;
  let closed = false;
  let pending: Delivery[] = [];
  let lastSeq = lastEventId;
  const liveSent = new Map<SegmentId, number>();

  const close = (): void => {
    closed = true;
  };

  const write = (text: string): boolean => {
    if (closed) return false;
    metrics.framesWritten += 1;
    const ok = res.write(text);
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      // A slow viewer never makes the server hold unbounded memory. It reconnects and resumes by seq.
      metrics.slowDisconnects += 1;
      close();
      res.destroy();
      return false;
    }
    return ok;
  };

  const writeAwait = async (text: string): Promise<void> => {
    const ok = write(text);
    if (ok || closed) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });
  };

  const writeDelivery = (delivery: Delivery): void => {
    let out = "";
    for (const event of delivery.events) {
      if (event.seq <= lastSeq) continue; // a duplicate from the catch-up: never sent twice
      out += event.sse;
      lastSeq = event.seq;
    }
    for (const update of delivery.live) {
      const sent = liveSent.get(update.segmentId);
      if (!update.reset && sent !== undefined && sent === update.previousLength) {
        out += liveFrameText(update, sent, update.text.slice(sent));
      } else {
        out += liveFrameText(update, 0, update.text);
      }
      liveSent.set(update.segmentId, update.text.length);
      if (liveSent.size > 400) {
        const oldest = liveSent.keys().next();
        if (!oldest.done) liveSent.delete(oldest.value);
      }
    }
    if (out.length > 0) write(out);
  };

  return {
    isClosed: () => closed,
    write,
    close,
    deliver: (delivery) => {
      if (closed) return;
      if (!caughtUp) {
        pending.push(delivery);
        return;
      }
      writeDelivery(delivery);
    },
    catchUp: async (db, taskId, from, to, liveSnapshot) => {
      let cursor = from;
      while (cursor < to && !closed) {
        const page = await rows(
          db,
          catchupRow,
          `SELECT seq, at_ms, kind, payload FROM events
           WHERE task_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq LIMIT ${String(CATCHUP_PAGE)}`,
          [taskId, cursor, to],
        );
        if (page.length === 0) break;
        let out = "";
        for (const row of page) {
          out += sseEvent(row.seq, row.at_ms, row.kind, row.payload);
          lastSeq = row.seq;
          cursor = row.seq;
        }
        await writeAwait(out);
      }
      for (const update of liveSnapshot) {
        await writeAwait(liveFrameText(update, 0, update.text));
        liveSent.set(update.segmentId, update.text.length);
      }
      caughtUp = true;
      const queued = pending;
      pending = [];
      for (const delivery of queued) writeDelivery(delivery);
    },
  };
};

export const openStream = (res: ServerResponse, lastEventId: number, metrics: SseMetrics): SseConnection => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  // EventSource reconnect delay.
  res.write("retry: 500\n\n");
  metrics.opened += 1;
  metrics.active += 1;
  const connection = createSseConnection(res, lastEventId, metrics);
  res.on("close", () => {
    connection.close();
    metrics.closed += 1;
    metrics.active -= 1;
  });
  return connection;
};

export const attach = async (
  tailer: Tailer,
  db: Db,
  taskId: TaskId,
  connection: SseConnection,
  lastEventId: number,
): Promise<void> => {
  const { startCursor, liveSnapshot } = await tailer.subscribe(taskId, connection);
  if (connection.isClosed()) {
    tailer.unsubscribe(taskId, connection);
    return;
  }
  // The caller sends hello with the head, then catch-up (lastEventId, startCursor], then the live tail.
  await connection.catchUp(db, taskId, lastEventId, startCursor, liveSnapshot);
};
