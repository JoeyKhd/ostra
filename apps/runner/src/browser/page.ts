import { z } from "zod";
import { devToolsError } from "./devtools-client.ts";
import type { DevToolsClient, DevToolsEvent } from "./devtools-client.ts";

// Milestone 8 (ticket 11): one page of the box's browser, on a flat session of its own: opened as
// a target, navigated, captured, screencast with acks, given input and closed. Tickets 13 (the
// screenshots and recordings, a page of their own each) and 18 (the shared page of the browser
// view) build on it. Every call has the client's deadline; every reply is checked. A page's
// content (its HTML, its text, a frame) is returned to the caller and never logged here.
//
// Ported from spikes/box-browser-stream/src/cdp/page.ts and src/sidecar/screencast.ts.

const createTargetSchema = z.looseObject({ targetId: z.string().min(1) });
const attachSchema = z.looseObject({ sessionId: z.string().min(1) });
const navigateSchema = z.looseObject({ frameId: z.string(), errorText: z.string().optional() });
const screenshotSchema = z.looseObject({ data: z.string() });
const evaluateSchema = z.looseObject({
  result: z.looseObject({ type: z.string(), value: z.unknown().optional() }),
  exceptionDetails: z.looseObject({ text: z.string() }).optional(),
});
const layoutSchema = z.looseObject({ cssContentSize: z.looseObject({ width: z.number(), height: z.number() }) });
const anything = z.looseObject({});

/** A screencast frame as `Page.screencastFrame` gives it: its picture, its number for the ack, and the page's size. */
const frameEventSchema = z.looseObject({
  data: z.string(),
  sessionId: z.number().int(),
  metadata: z.looseObject({ deviceWidth: z.number(), deviceHeight: z.number(), timestamp: z.number().optional() }),
});

/** The page's size in CSS pixels, and whether it's a phone (touch, `mobile`). */
export type Viewport = { readonly width: number; readonly height: number; readonly mobile: boolean };

export type ScreenshotOptions = {
  readonly format: "png" | "jpeg";
  /** JPEG only, 0 to 100. */
  readonly quality?: number;
  /** The whole page, past the viewport, up to `maxHeight` pixels high in the picture. */
  readonly fullPage?: boolean;
  readonly maxHeight?: number;
  /** Ticket 13: the whole page's picture at most this wide, in pixels: a page wider than its viewport. */
  readonly maxWidth?: number;
  /**
   * Ticket 13: a phone's width. A page laid out wider than it (one with no viewport tag lays out at
   * 980 px on a phone) is zoomed out to fit, as the phone shows it, in the full page too.
   */
  readonly fitWidth?: number;
};

export type ScreencastOptions = {
  readonly format: "jpeg" | "png";
  readonly quality: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** How many frames the browser may send before one is acked (spike 07: 1 for the view). */
  readonly maxFramesInFlight?: number;
  /** Send the newest frame at once when the ack comes, so the last change before a pause isn't lost (spike 07). */
  readonly sendLastFrame?: boolean;
  readonly everyNthFrame?: number;
};

export type ScreencastFrame = { readonly data: Buffer; readonly width: number; readonly height: number; readonly timestamp: number | null };

/** Mouse input as `Input.dispatchMouseEvent` takes it. */
export type MouseInput = {
  readonly type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  readonly x: number;
  readonly y: number;
  readonly button?: "none" | "left" | "middle" | "right";
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly modifiers?: number;
};

/** Key input as `Input.dispatchKeyEvent` takes it: `rawKeyDown` with a virtual-key code for keys that type nothing (spike 07). */
export type KeyInput = {
  readonly type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  readonly key?: string;
  readonly code?: string;
  readonly text?: string;
  readonly windowsVirtualKeyCode?: number;
  readonly modifiers?: number;
};

export type Page = {
  readonly targetId: string;
  readonly sessionId: string;
  readonly setViewport: (viewport: Viewport) => Promise<void>;
  /** Goes to `url` and waits for the page's load event, within `deadlineMs`. A navigation error fails with its `errorText` as the detail. */
  readonly navigate: (url: string, deadlineMs?: number) => Promise<void>;
  /** A value the page computes (`returnByValue`), checked against `schema`. */
  readonly evaluate: <T>(expression: string, schema: z.ZodType<T>) => Promise<T>;
  readonly screenshot: (options: ScreenshotOptions) => Promise<Buffer>;
  /**
   * Streams the page's frames: each one to `onFrame`, and acked once `onFrame` resolves, so a slow
   * reader slows the browser down (the screencast's back-pressure). Resolves with the stop.
   */
  readonly startScreencast: (options: ScreencastOptions, onFrame: (frame: ScreencastFrame) => Promise<void> | void) => Promise<() => Promise<void>>;
  readonly mouse: (input: MouseInput) => Promise<void>;
  readonly key: (input: KeyInput) => Promise<void>;
  /** Text as if pasted: accents and symbols intact (spike 07). */
  readonly insertText: (text: string) => Promise<void>;
  /** Hears this page's events of `method`. Returns the unsubscribe. */
  readonly onEvent: (method: string, listener: (params: unknown) => void) => () => void;
  /** Closes the target. Harmless once the browser is gone. */
  readonly close: () => Promise<void>;
};

/** Opens a page of its own on `about:blank`, attached with a flat session, at `viewport`. */
export const openPage = async (client: DevToolsClient, viewport: Viewport): Promise<Page> => {
  const { targetId } = await client.call("Target.createTarget", { url: "about:blank" }, createTargetSchema);
  const { sessionId } = await client.call("Target.attachToTarget", { targetId, flatten: true }, attachSchema);
  const on = { sessionId };
  const onEvent = (method: string, listener: (params: unknown) => void): (() => void) =>
    client.onEvent((event: DevToolsEvent) => {
      if (event.sessionId === sessionId && event.method === method) listener(event.params);
    });

  const setViewport = async (next: Viewport): Promise<void> => {
    await client.command(
      "Emulation.setDeviceMetricsOverride",
      { width: next.width, height: next.height, deviceScaleFactor: 1, mobile: next.mobile, screenWidth: next.width, screenHeight: next.height },
      on,
    );
    await client.command("Emulation.setTouchEmulationEnabled", { enabled: next.mobile }, on);
  };

  await client.command("Page.enable", {}, on);
  await setViewport(viewport);

  const navigate = async (url: string, deadlineMs = 30_000): Promise<void> => {
    let off = (): void => undefined;
    let timer: NodeJS.Timeout | undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(devToolsError("deadline", "Page.loadEventFired"));
      }, deadlineMs);
      off = onEvent("Page.loadEventFired", () => {
        resolve();
      });
    });
    // Its rejection is read below, whichever way the navigation goes.
    loaded.catch(() => undefined);
    try {
      const answer = await client.call("Page.navigate", { url }, navigateSchema, { ...on, deadlineMs });
      if (answer.errorText !== undefined) throw devToolsError("protocol", "Page.navigate", answer.errorText.slice(0, 200));
      await loaded;
    } finally {
      clearTimeout(timer);
      off();
    }
  };

  const evaluate = async <T>(expression: string, schema: z.ZodType<T>): Promise<T> => {
    const reply = await client.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, evaluateSchema, on);
    if (reply.exceptionDetails !== undefined) throw devToolsError("protocol", "Runtime.evaluate", reply.exceptionDetails.text.slice(0, 200));
    const value = schema.safeParse(reply.result.value);
    if (!value.success) throw devToolsError("unparsable", "Runtime.evaluate");
    return value.data;
  };

  const screenshot = async (options: ScreenshotOptions): Promise<Buffer> => {
    const params: Record<string, unknown> = { format: options.format, ...(options.format === "jpeg" && options.quality !== undefined ? { quality: options.quality } : {}) };
    if (options.fullPage === true) {
      const { cssContentSize } = await client.call("Page.getLayoutMetrics", {}, layoutSchema, on);
      const contentWidth = Math.max(1, Math.ceil(cssContentSize.width));
      const scale = options.fitWidth !== undefined && contentWidth > options.fitWidth ? options.fitWidth / contentWidth : 1;
      // The caps are the picture's pixels: the page's CSS pixels times the scale.
      const width = Math.max(1, Math.min(contentWidth, Math.floor((options.maxWidth ?? Number.MAX_SAFE_INTEGER) / scale)));
      const height = Math.max(1, Math.min(Math.ceil(cssContentSize.height), Math.floor((options.maxHeight ?? Number.MAX_SAFE_INTEGER) / scale)));
      params["captureBeyondViewport"] = true;
      params["clip"] = { x: 0, y: 0, width, height, scale };
    }
    const { data } = await client.call("Page.captureScreenshot", params, screenshotSchema, on);
    return Buffer.from(data, "base64");
  };

  const startScreencast = async (options: ScreencastOptions, onFrame: (frame: ScreencastFrame) => Promise<void> | void): Promise<() => Promise<void>> => {
    // Read again after each frame's reader: the stop may have come while it ran.
    const state = { running: true };
    const off = onEvent("Page.screencastFrame", (params) => {
      const frame = frameEventSchema.safeParse(params);
      if (!frame.success || !state.running) return;
      const { data, sessionId: frameNumber, metadata } = frame.data;
      void (async () => {
        try {
          await onFrame({ data: Buffer.from(data, "base64"), width: metadata.deviceWidth, height: metadata.deviceHeight, timestamp: metadata.timestamp ?? null });
        } catch {
          // A reader that failed still acks: the stream goes on, and the caller stops it.
        }
        if (state.running) await client.command("Page.screencastFrameAck", { sessionId: frameNumber }, on).catch(() => undefined);
      })();
    });
    await client.command(
      "Page.startScreencast",
      {
        format: options.format,
        quality: options.quality,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        everyNthFrame: options.everyNthFrame ?? 1,
        ...(options.maxFramesInFlight === undefined ? {} : { maxFramesInFlight: options.maxFramesInFlight }),
        ...(options.sendLastFrame === undefined ? {} : { sendLastFrame: options.sendLastFrame }),
      },
      on,
    );
    return async () => {
      state.running = false;
      off();
      await client.command("Page.stopScreencast", {}, on).catch(() => undefined);
    };
  };

  return {
    targetId,
    sessionId,
    setViewport,
    navigate,
    evaluate,
    screenshot,
    startScreencast,
    mouse: (input) => client.command("Input.dispatchMouseEvent", input, on),
    key: (input) => client.command("Input.dispatchKeyEvent", input, on),
    insertText: (text) => client.command("Input.insertText", { text }, on),
    onEvent,
    close: async () => {
      await client.call("Target.closeTarget", { targetId }, anything).catch(() => undefined);
    },
  };
};
