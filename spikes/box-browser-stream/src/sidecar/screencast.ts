import { z } from "zod";
import type { Page } from "../cdp/page.ts";

// Page.startScreencast on the shared page, with back-pressure end to end: the browser holds at most
// `inflight` frames until they're acked (maxFramesInFlight), and the sidecar acks a frame only once the
// sink (core) has taken it. A frame-rate cap is applied one of two ways:
// - "ack": the ack is held until 1/cap s after the previous one, so the browser itself produces fewer frames;
//   sendLastFrame makes it send the newest frame at once when the ack comes, so the last change isn't lost.
// - "drop": every frame is acked at once and the sidecar forwards at most cap a second, keeping the newest
//   one for the next slot (a trailing edge), so the browser encodes frames the member never sees.

const frameSchema = z.looseObject({
  data: z.string(),
  sessionId: z.number(),
  metadata: z.looseObject({ deviceWidth: z.number(), deviceHeight: z.number(), timestamp: z.number().optional() }),
});

export type CapMode = "ack" | "drop";

export type ScreencastOptions = {
  readonly format: "jpeg" | "png";
  readonly quality: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly inflight: number;
  readonly fpsCap: number;
  readonly capMode: CapMode;
  readonly sendLastFrame: boolean;
};

export type OutFrame = { readonly at: number; readonly w: number; readonly h: number; readonly data: Buffer };
export type FrameSink = (frame: OutFrame) => Promise<void>;

export type ScreencastStats = {
  produced: number;
  producedBytes: number;
  forwarded: number;
  forwardedBytes: number;
  dropped: number;
  decodeMs: number;
};

export const emptyStats = (): ScreencastStats => ({ produced: 0, producedBytes: 0, forwarded: 0, forwardedBytes: 0, dropped: 0, decodeMs: 0 });

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const startScreencast = async (page: Page, options: ScreencastOptions, sink: FrameSink, stats: ScreencastStats) => {
  const interval = options.fpsCap > 0 ? 1000 / options.fpsCap : 0;
  let running = true;
  let lastAckAt = 0;
  let lastSentAt = 0;
  let sending = false;
  let pending: OutFrame | null = null;
  let timer: NodeJS.Timeout | null = null;

  const ack = (frameNumber: number) => {
    if (!running) return;
    page.send("Page.screencastFrameAck", { sessionId: frameNumber }).catch(() => undefined);
  };

  const forward = async (frame: OutFrame) => {
    sending = true;
    lastSentAt = Date.now();
    stats.forwarded += 1;
    stats.forwardedBytes += frame.data.length;
    try {
      await sink(frame);
    } finally {
      sending = false;
    }
  };

  const flushPending = () => {
    timer = null;
    if (!running || sending || pending === null) return;
    const wait = lastSentAt + interval - Date.now();
    if (wait > 0) {
      timer = setTimeout(flushPending, wait);
      return;
    }
    const next = pending;
    pending = null;
    void forward(next).then(() => {
      if (pending !== null && timer === null) flushPending();
    });
  };

  const off = page.onEvent("Page.screencastFrame", (params) => {
    const event = frameSchema.parse(params);
    const started = performance.now();
    const data = Buffer.from(event.data, "base64");
    stats.decodeMs += performance.now() - started;
    stats.produced += 1;
    stats.producedBytes += data.length;
    const frame: OutFrame = { at: Date.now(), w: Math.round(event.metadata.deviceWidth), h: Math.round(event.metadata.deviceHeight), data };

    if (options.capMode === "drop" && interval > 0) {
      ack(event.sessionId);
      if (pending !== null) stats.dropped += 1;
      pending = frame;
      if (timer === null) flushPending();
      return;
    }
    void (async () => {
      await forward(frame);
      if (interval > 0) {
        const wait = lastAckAt + interval - Date.now();
        if (wait > 0) await delay(wait);
      }
      lastAckAt = Date.now();
      ack(event.sessionId);
    })();
  });

  const params: Record<string, unknown> = {
    format: options.format,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    everyNthFrame: 1,
    maxFramesInFlight: options.inflight,
    sendLastFrame: options.sendLastFrame,
  };
  if (options.format === "jpeg") params["quality"] = options.quality;
  await page.send("Page.startScreencast", params);

  return {
    stop: async () => {
      running = false;
      off();
      if (timer !== null) clearTimeout(timer);
      await page.send("Page.stopScreencast").catch(() => undefined);
    },
  };
};
