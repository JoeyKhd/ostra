import { silentLogger } from "@ostra/adapter-sdk";
import { previewKeySchema, previewViewIdSchema, runnerLimits } from "@ostra/protocol";
import type { PreviewViewport } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { DevToolsClient, DevToolsEvent } from "../browser/devtools-client.ts";
import type { PreviewFrame } from "../connection/preview-frames.ts";
import { createSharedPages } from "./shared-pages.ts";
import type { SharedPages } from "./shared-pages.ts";

// A still page's sharp frame (F-141/c10; ADR 0068, the lead, 2026-11-21): the shared page's own
// logic against a browser this test plays, frame by frame, so each rule is timed exactly: one still
// frame once the page sent nothing for `browserViewStillAfterMs`, at `browserViewStillQuality` and
// the viewers' device pixel ratio, the moving frames as they were, and the browser's own frames of
// the capture taken for what they are. The machine's real browser does it in
// `preview-stream.host.test.ts` (`testing/preview-stream-cases.ts`).

const KEY = previewKeySchema.parse("app-web");
const DESKTOP: PreviewViewport = { width: 1440, height: 900 };

/** A JPEG with no pixels: its start, a frame header (SOF0) naming its size, a comment, and its end. */
const jpegOf = (width: number, height: number, text: string): Buffer => {
  const header = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  header.writeUInt16BE(height, 5);
  header.writeUInt16BE(width, 7);
  const comment = Buffer.from([0xff, 0xfe, 0, 0]);
  comment.writeUInt16BE(Buffer.byteLength(text) + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, comment, Buffer.from(text), Buffer.from([0xff, 0xd9])]);
};

/** A JPEG's size from its frame header, and its comment. */
const pictureOf = (jpeg: Uint8Array): { readonly width: number; readonly height: number; readonly text: string } => {
  const bytes = Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  return { width: bytes.readUInt16BE(9), height: bytes.readUInt16BE(7), text: bytes.subarray(25, bytes.length - 2).toString("utf8") };
};

type Sent = { readonly method: string; readonly params: Readonly<Record<string, unknown>> };

/**
 * A browser this test plays: it answers the shared page's calls as Chromium does (a capture's
 * picture is the page's size times its device pixel ratio, its comment naming its quality), sends
 * the screencast frames the test asks for, and can hold a capture until the test lets it go.
 */
const playedBrowser = () => {
  const sent: Sent[] = [];
  const listeners = new Set<(event: DevToolsEvent) => void>();
  let metrics = { width: 1440, height: 900, scale: 1 };
  let held: Promise<void> | null = null;
  let release = (): void => undefined;
  let castFrame = 0;
  const emit = (method: string, params: unknown): void => {
    for (const listener of listeners) listener({ method, params, sessionId: "S1" });
  };
  const answer = async (method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> => {
    sent.push({ method, params });
    switch (method) {
      case "Target.createTarget":
        return { targetId: "T1" };
      case "Target.attachToTarget":
        return { sessionId: "S1" };
      case "Page.navigate":
        setTimeout(() => {
          emit("Page.loadEventFired", { timestamp: 1 });
        }, 0);
        return { frameId: "F1" };
      case "Emulation.setDeviceMetricsOverride":
        metrics = { width: Number(params["width"]), height: Number(params["height"]), scale: Number(params["deviceScaleFactor"]) };
        return {};
      case "Page.captureScreenshot": {
        await held;
        const picture = jpegOf(Math.round(metrics.width * metrics.scale), Math.round(metrics.height * metrics.scale), `still q${String(params["quality"])}`);
        return { data: picture.toString("base64") };
      }
      default:
        return {};
    }
  };
  const client: DevToolsClient = {
    call: async (method, params, schema) => schema.parse(await answer(method, params)),
    command: async (method, params) => {
      await answer(method, params);
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refused: () => 0,
    closed: new Promise<void>(() => undefined),
  };
  return {
    client,
    sent,
    /** The calls of one method, in order. */
    calls: (method: string): readonly Readonly<Record<string, unknown>>[] => sent.filter((each) => each.method === method).map((each) => each.params),
    /** A screencast frame: the page's picture `text`, at the page's size unless it names another, as Chromium reports it (CSS pixels). */
    frame: (text: string, size: { readonly width: number; readonly height: number } = metrics) => {
      castFrame += 1;
      emit("Page.screencastFrame", { data: jpegOf(size.width, size.height, text).toString("base64"), sessionId: castFrame, metadata: { deviceWidth: size.width, deviceHeight: size.height } });
    },
    /** Holds every capture until `letGo`. */
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    letGo: () => {
      held = null;
      release();
    },
  };
};

/** A view's frames as its core took them, each at once. */
const takingSink = () => {
  const frames: { readonly frame: PreviewFrame; readonly at: number }[] = [];
  return { frames, sink: { send: (frame: PreviewFrame) => { frames.push({ frame, at: Date.now() }); return Promise.resolve(true); } } };
};

const waitUntil = async (what: string, check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let pages: SharedPages | null = null;
afterEach(async () => {
  await pages?.closeAll();
  pages = null;
});

const start = async (viewport: PreviewViewport = { ...DESKTOP, scale: 2 }) => {
  const browser = playedBrowser();
  const made = createSharedPages({ browser: () => Promise.resolve({ available: true, browser: { name: "Played", version: "1" }, client: browser.client }), framesPerSecond: () => runnerLimits.browserViewFramesPerSecond, mayLoad: () => true, logger: silentLogger });
  pages = made;
  const view = takingSink();
  expect(await made.attach({ viewId: previewViewIdSchema.parse("view-1"), key: KEY, origin: "http://localhost:5173", path: "/", viewport, sink: view.sink })).toEqual({ ok: true });
  return { browser, pages: made, view };
};

describe("a still page's sharp frame", () => {
  it("F-141/c10: once the page sends nothing for the wait, one still frame at quality 90 and the viewer's scale, its header the page's size; a move brings quality-60 frames at the page's size back, then a still again", async () => {
    const { browser, pages: made, view } = await start();
    // The page's device pixel ratio is the viewer's; the moving frames stay at the page's CSS size and quality 60.
    expect(browser.calls("Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({ width: 1440, height: 900, deviceScaleFactor: 2 });
    expect(browser.calls("Page.startScreencast").at(-1)).toMatchObject({ format: "jpeg", quality: runnerLimits.browserViewQuality, maxWidth: 1440, maxHeight: 900 });
    browser.frame("moving 1");
    await waitUntil("the moving frame", () => view.frames.length === 1);
    const moving = view.frames[0];
    expect({ ...moving?.frame.header, at: 0 }).toEqual({ seq: 1, at: 0, width: 1440, height: 900 });
    expect(pictureOf(moving?.frame.jpeg ?? new Uint8Array())).toMatchObject({ width: 1440, height: 900, text: "moving 1" });
    // No frame for the wait: the still, sharp.
    await waitUntil("the still frame", () => view.frames.length === 2);
    const still = view.frames[1];
    expect({ ...still?.frame.header, at: 0 }).toEqual({ seq: 2, at: 0, width: 1440, height: 900, still: true });
    expect(pictureOf(still?.frame.jpeg ?? new Uint8Array())).toEqual({ width: 2880, height: 1800, text: `still q${String(runnerLimits.browserViewStillQuality)}` });
    expect((still?.at ?? 0) - (moving?.at ?? 0)).toBeGreaterThanOrEqual(runnerLimits.browserViewStillAfterMs);
    expect(browser.calls("Page.captureScreenshot")).toEqual([{ format: "jpeg", quality: runnerLimits.browserViewStillQuality }]);
    expect(made.counts(KEY)).toMatchObject({ stills: 1 });
    // The page moves: the moving frames come as before, and once it rests again, its still.
    browser.frame("moving 2");
    await waitUntil("the next moving frame", () => view.frames.length === 3);
    expect(view.frames[2]?.frame.header.still).toBeUndefined();
    expect(pictureOf(view.frames[2]?.frame.jpeg ?? new Uint8Array())).toMatchObject({ width: 1440, height: 900, text: "moving 2" });
    await waitUntil("the second still", () => view.frames.length === 4, 8_000);
    expect(view.frames[3]?.frame.header.still).toBe(true);
    // A view that joins a page at rest gets its still at once.
    const late = takingSink();
    expect(await made.attach({ viewId: previewViewIdSchema.parse("view-2"), key: KEY, origin: "http://localhost:5173", path: "/", viewport: { ...DESKTOP, scale: 2 }, sink: late.sink })).toEqual({ ok: true });
    await waitUntil("the joiner's frame", () => late.frames.length === 1);
    expect(late.frames[0]?.frame.header.still).toBe(true);
  });

  it("F-141/c10: the browser's own frames of a still's capture aren't the page moving: the same picture again, or one at the capture's size, is never sent and takes no new still", async () => {
    const { browser, pages: made, view } = await start();
    browser.frame("page");
    await waitUntil("the moving frame", () => view.frames.length === 1);
    // The capture is held: meanwhile the browser sends a frame at the capture's size, and its last picture again.
    browser.hold();
    await waitUntil("the capture", () => browser.calls("Page.captureScreenshot").length === 1, 3_000);
    browser.frame("capture's own", { width: 2880, height: 1800 });
    browser.frame("page");
    await sleep(100);
    browser.letGo();
    await waitUntil("the still frame", () => view.frames.length === 2);
    expect(view.frames[1]?.frame.header.still).toBe(true);
    // Its picture once more after the capture: not the page moving, so nothing is sent and no still follows.
    browser.frame("page");
    await sleep(runnerLimits.browserViewStillAfterMs * 3);
    expect(view.frames).toHaveLength(2);
    expect(browser.calls("Page.captureScreenshot")).toHaveLength(1);
    expect(made.counts(KEY)).toMatchObject({ stills: 1 });
  });

  it("F-141/c10: a still taken while the page moved is dropped, and a still the page replaced within 2 s makes the next wait twice as long", async () => {
    const { browser, view } = await start();
    browser.frame("first");
    await waitUntil("the moving frame", () => view.frames.length === 1);
    browser.hold();
    await waitUntil("the capture", () => browser.calls("Page.captureScreenshot").length === 1, 3_000);
    // The page moves while the still is taken: the move goes, the still never does.
    browser.frame("moved meanwhile");
    await waitUntil("the move", () => view.frames.length === 2);
    browser.letGo();
    await sleep(50);
    expect(view.frames.map(({ frame }) => frame.header.still ?? false)).toEqual([false, false]);
    // At rest: its still, after the usual wait.
    await waitUntil("the still", () => view.frames.length === 3);
    expect(view.frames[2]?.frame.header.still).toBe(true);
    // Replaced within 2 s: the next still waits twice as long.
    browser.frame("ticks");
    await waitUntil("the tick", () => view.frames.length === 4);
    const tickAt = view.frames[3]?.at ?? 0;
    await waitUntil("the next still", () => view.frames.length === 5, 8_000);
    expect(view.frames[4]?.frame.header.still).toBe(true);
    expect((view.frames[4]?.at ?? 0) - tickAt).toBeGreaterThanOrEqual(2 * runnerLimits.browserViewStillAfterMs);
  });

  it("F-141/c10: the page's device pixel ratio is its viewers' highest, 2 at most, and the moving frames stay at the page's size at every ratio", async () => {
    const { browser, pages: made } = await start({ ...DESKTOP });
    expect(browser.calls("Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({ deviceScaleFactor: 1 });
    // A viewer on a screen at 3 joins: the page goes to 2, the cap, and its screencast stays within the page's CSS size.
    const second = takingSink();
    const viewId = previewViewIdSchema.parse("view-hidpi");
    expect(await made.attach({ viewId, key: KEY, origin: "http://localhost:5173", path: "/", viewport: { ...DESKTOP, scale: 3 }, sink: second.sink })).toEqual({ ok: true });
    await waitUntil("the page at 2", () => browser.calls("Emulation.setDeviceMetricsOverride").at(-1)?.["deviceScaleFactor"] === 2);
    await waitUntil("the screencast again", () => browser.calls("Page.startScreencast").length === 2);
    expect(browser.calls("Page.startScreencast").at(-1)).toMatchObject({ quality: runnerLimits.browserViewQuality, maxWidth: 1440, maxHeight: 900 });
    // At rest, its still is the page's pixels times 2: a frame at DPR 2.
    browser.frame("at 2");
    await waitUntil("the still at 2", () => second.frames.some(({ frame }) => frame.header.still === true));
    const still = second.frames.find(({ frame }) => frame.header.still === true);
    expect(still?.frame.header).toMatchObject({ width: 1440, height: 900 });
    expect(pictureOf(still?.frame.jpeg ?? new Uint8Array())).toMatchObject({ width: 2880, height: 1800 });
    // A viewer's own width control may name its ratio; the HiDPI viewer leaving brings the page back to 1.
    await made.control(viewId, { kind: "viewport", viewport: { width: 834, height: 1112, scale: 1 } });
    expect(browser.calls("Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({ width: 834, height: 1112, deviceScaleFactor: 1 });
    await made.control(viewId, { kind: "viewport", viewport: { width: 834, height: 1112, scale: 2 } });
    expect(browser.calls("Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({ width: 834, height: 1112, deviceScaleFactor: 2 });
    await made.detach(viewId);
    await waitUntil("the page at 1", () => browser.calls("Emulation.setDeviceMetricsOverride").at(-1)?.["deviceScaleFactor"] === 1);
    expect(browser.calls("Emulation.setDeviceMetricsOverride").at(-1)).toMatchObject({ width: 834, height: 1112 });
  });
});
