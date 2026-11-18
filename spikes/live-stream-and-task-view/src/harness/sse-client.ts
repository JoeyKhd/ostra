import http from "node:http";
import { liveFrame, storedEventSchema, type LiveFrame, type StoredEvent } from "../shared/events.ts";
import { sleep } from "../shared/time.ts";

export type RawFrame = { id: string | null; event: string; data: string };

export type SseClientOptions = {
  readonly baseUrl: string;
  readonly path: string;
  readonly cookie: string;
  readonly lastEventId?: number;
  readonly onFrame?: (frame: RawFrame, receivedAt: number) => void;
};

export type SseClientStats = { gaps: number; duplicates: number; invalid: number; status: number; closed: boolean };

export type SseClient = {
  readonly frames: RawFrame[];
  readonly events: StoredEvent[];
  readonly live: LiveFrame[];
  readonly receivedAt: number[];
  // for every committed event, milliseconds from the runner's emit time (`at`) to this client reading it
  readonly latencies: number[];
  readonly stats: SseClientStats;
  readonly lastSeen: () => number;
  readonly open: () => Promise<void>;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number) => Promise<boolean>;
  readonly close: () => void;
};

// A small SSE client over node:http: it keeps raw frames, so tests can check that live frames carry no id.
export const createSseClient = (options: SseClientOptions): SseClient => {
  const frames: RawFrame[] = [];
  const events: StoredEvent[] = [];
  const live: LiveFrame[] = [];
  const receivedAt: number[] = [];
  const latencies: number[] = [];
  const stats: SseClientStats = { gaps: 0, duplicates: 0, invalid: 0, status: 0, closed: false };
  let buffer = "";
  let request: http.ClientRequest | null = null;
  let response: http.IncomingMessage | null = null;
  let lastSeq = options.lastEventId ?? 0;

  const interpret = (frame: RawFrame, now: number): void => {
    let json: unknown;
    try {
      json = JSON.parse(frame.data);
    } catch {
      stats.invalid += 1;
      return;
    }
    if (frame.event === "event") {
      const parsed = storedEventSchema.safeParse(json);
      if (!parsed.success) {
        stats.invalid += 1;
        return;
      }
      const event = parsed.data;
      if (event.seq <= lastSeq) {
        stats.duplicates += 1;
        return;
      }
      if (event.seq !== lastSeq + 1) stats.gaps += 1;
      lastSeq = event.seq;
      events.push(event);
      latencies.push(Math.max(0, now - event.at));
    } else if (frame.event === "live") {
      const parsed = liveFrame.safeParse(json);
      if (parsed.success) live.push(parsed.data);
      else stats.invalid += 1;
    }
  };

  const drain = (): void => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) return;
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let id: string | null = null;
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("id: ")) id = line.slice(4);
        else if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data.push(line.slice(6));
      }
      if (data.length === 0 && event === "message") continue;
      const frame: RawFrame = { id, event, data: data.join("\n") };
      const now = Date.now();
      frames.push(frame);
      receivedAt.push(now);
      options.onFrame?.(frame, now);
      interpret(frame, now);
    }
  };

  return {
    frames,
    events,
    live,
    receivedAt,
    latencies,
    stats,
    lastSeen: () => lastSeq,
    open: () => {
      const url = new URL(options.path, options.baseUrl);
      return new Promise<void>((resolve, reject) => {
        const headers: Record<string, string> = { cookie: options.cookie, accept: "text/event-stream" };
        if (options.lastEventId !== undefined && options.lastEventId > 0) {
          headers["last-event-id"] = String(options.lastEventId);
        }
        const made = http.get(
          { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers, agent: false },
          (reply) => {
            response = reply;
            stats.status = reply.statusCode ?? 0;
            reply.setEncoding("utf8");
            reply.on("data", (chunk: string) => {
              buffer += chunk;
              drain();
            });
            reply.on("close", () => {
              stats.closed = true;
            });
            resolve();
          },
        );
        made.on("error", (error) => {
          stats.closed = true;
          reject(error);
        });
        request = made;
      });
    },
    waitFor: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(10);
      }
      return predicate();
    },
    close: () => {
      stats.closed = true;
      response?.destroy();
      request?.destroy();
    },
  };
};

// What a viewer sees once its live frames are applied: segment id -> accumulated text.
export const applyLive = (frames: readonly LiveFrame[]): Map<string, string> => {
  const text = new Map<string, string>();
  for (const frame of frames) {
    if (frame.offset === 0) text.set(frame.segmentId, frame.text);
    else if ((text.get(frame.segmentId)?.length ?? -1) === frame.offset) text.set(frame.segmentId, (text.get(frame.segmentId) ?? "") + frame.text);
  }
  return text;
};
