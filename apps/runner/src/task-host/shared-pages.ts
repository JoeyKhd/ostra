import type { Logger } from "@ostra/adapter-sdk";
import { browserViewFrameBounds, browserViewStillScale, runnerLimits, viewportPresetSizes } from "@ostra/protocol";
import type { PreviewControl, PreviewInputEvent, PreviewKey, PreviewPageControl, PreviewViewId, PreviewViewport } from "@ostra/protocol";
import type { z } from "zod";
import type { OpenBoxBrowser } from "../browser/box-browser.ts";
import { openPage } from "../browser/page.ts";
import type { Page, ScreencastFrame, Viewport } from "../browser/page.ts";
import { dispatchViewInput } from "../browser/view-input.ts";
import type { PreviewFrame } from "../connection/preview-frames.ts";

// Milestone 8's ticket 18 (F-141, ADR 0068 "The browser view", Q314): the browser view's shared
// pages, one per preview in the box's browser, shared by every view of it, like a shared screen.
//
// - **The page** opens on the first view of its preview, loads the preview at its path, and closes
//   with the last view. The width is the last one chosen.
// - **The screencast** (spike 07's defaults): JPEG at quality 60, at the page's own size (within
//   1440×900's pixels, Q326), one frame in flight, `sendLastFrame` on. The rate is capped by
//   holding each frame's ack to the browser, never by dropping frames: 15 a second on the
//   WebSocket, 2 on the HTTP carrier. The ack goes
//   back once a view's core took the newest frame, so `maxFramesInFlight` holds the browser to what
//   core takes: a member who reads slowly slows the browser rather than queueing frames in core.
// - **Each view** has at most one frame with its core. A view that's behind gets the newest frame
//   once it took the one it has, so a slow member never holds a fast one back, and a view that
//   joins gets the newest frame at once (a still page sends no new one).
// - **A still page is sharp** (the lead, 2026-11-21): once the page sent no frame for
//   `browserViewStillAfterMs` after the last one's ack, the box takes one picture of it at
//   `browserViewStillQuality` and sends it to every view as a `still` frame, which a view that joins
//   then gets too. The page's device pixel ratio is its viewers' highest (`browserViewStillScale`,
//   2 at most), so on a HiDPI screen the still is drawn at the screen's own pixels; the moving
//   frames stay at the page's CSS size and quality 60, so motion costs what it did. A still the page
//   replaced within 2 s makes the next wait twice as long, up to `browserViewStillAfterMaxMs`, so a
//   page that ticks every second doesn't send a sharp frame each time. The browser's own frames of
//   the picture (the same picture again, or one at the capture's size) aren't the page moving.
// - **Control and input** (`viewport`, `navigate`, `reload`, `input`) apply to the shared page, one
//   at a time, in the order they came.
// - **The reach rule** holds on every document the page loads (`mayLoad`): a click on a link to the
//   key proxy, or to any box port no preview may reach, never leaves the browser.
//
// Only frames leave: never the page's text, its cookies or its addresses. IDs, keys and counts are
// logged; a path, typed text and a frame never are.

export type FrameSink = {
  /** Sends one frame to the view's core: `true` once core took it, `false` when the view ended first. */
  readonly send: (frame: PreviewFrame) => Promise<boolean>;
};

export type SharedPagesDeps = {
  /** The box's browser, started on first use (`boxBrowser`'s `open`). */
  readonly browser: () => Promise<OpenBoxBrowser>;
  /** The browser view's frames a second now: 15 on the WebSocket, 2 on the HTTP carrier. */
  readonly framesPerSecond: () => number;
  /** The reach rule for a document the page would load, by its address. */
  readonly mayLoad: (url: string) => boolean;
  readonly logger: Logger;
  /** How long the page's first load may take (default 30 s): a page still loading is streamed as it is. */
  readonly loadMs?: number;
};

export type AttachInput = {
  readonly viewId: PreviewViewId;
  readonly key: PreviewKey;
  /** Where the box's browser opens the preview, such as `http://localhost:5173`. Never logged. */
  readonly origin: string;
  /** The preview's path. Never logged. */
  readonly path: string;
  readonly viewport: PreviewViewport;
  readonly sink: FrameSink;
};

/** Why a view got no page: the box has no browser, the browser failed, or the view went first. */
export type AttachRefusal = "no-browser" | "browser-failed" | "detached";

export type AttachOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: AttachRefusal };

/** A shared page's counts, for the log and the tests. */
export type SharedPageCounts = {
  /** Frames the browser sent. */
  readonly frames: number;
  /** Frames a view's core took. */
  readonly taken: number;
  /** Views watching it. */
  readonly views: number;
  /** Input events applied, and refused by the page. */
  readonly inputs: number;
  readonly inputsFailed: number;
  /** Documents the reach rule kept from loading. */
  readonly blocked: number;
  /** Still frames sent: the page at rest, sharp. */
  readonly stills: number;
};

export type SharedPages = {
  /** Attaches a view to its preview's page, opening the page and its screencast for the first view. */
  readonly attach: (input: AttachInput) => Promise<AttachOutcome>;
  /** Detaches a view; the page closes with its last view. */
  readonly detach: (viewId: PreviewViewId) => Promise<void>;
  /**
   * Applies core's control to the view's page, after what came before it: one from the view's
   * connection, or one of the pane's from the HTTP carrier's `preview.input`. `false` when the view
   * has no page.
   */
  readonly control: (viewId: PreviewViewId, control: PreviewControl | PreviewPageControl) => Promise<boolean>;
  /** Applies a member's input to the view's page, in order (the HTTP carrier's `preview.input`). */
  readonly input: (viewId: PreviewViewId, events: readonly PreviewInputEvent[]) => Promise<boolean>;
  /** How many pages are open or opening: each a preview someone watches. */
  readonly pages: () => number;
  /** Whether the preview has a page now. */
  readonly hasPage: (key: PreviewKey) => boolean;
  readonly counts: (key: PreviewKey) => SharedPageCounts | undefined;
  /** Evaluates `expression` in the preview's page (the tests' look at what a member's input did). */
  readonly evaluate: <T>(key: PreviewKey, expression: string, schema: z.ZodType<T>) => Promise<T>;
  /** Ends every page: the box is stopping. */
  readonly closeAll: () => Promise<void>;
};

/** One view on its page: whether a frame is with its core, and whether a newer one came meanwhile. */
type Watcher = {
  readonly viewId: PreviewViewId;
  readonly sink: FrameSink;
  busy: boolean;
  behind: boolean;
  /** The last frame sent to it. */
  sent: number;
  /** The viewer's device pixel ratio, for the page's still frames (`browserViewStillScale`). */
  scale: number;
};

type Opened = { readonly ok: true; readonly page: Page } | { readonly ok: false; readonly reason: AttachRefusal };

type Shared = {
  readonly key: PreviewKey;
  readonly origin: string;
  readonly watchers: Map<PreviewViewId, Watcher>;
  opened: Promise<Opened>;
  stopCast: (() => Promise<void>) | null;
  viewport: Viewport;
  seq: number;
  newest: PreviewFrame | null;
  /** Lets the browser's ack of the newest frame go: a view took it, or the page is ending. */
  release: (() => void) | null;
  lastAckAt: number;
  ended: boolean;
  /** Controls and input, one at a time, in order. */
  queue: Promise<void>;
  frames: number;
  taken: number;
  inputs: number;
  inputsFailed: number;
  blocked: number;
  // ---- the page at rest (2026-11-21) ----
  /** The still frame's timer, while the page sends nothing. */
  stillTimer: NodeJS.Timeout | null;
  /** How long the page must send nothing before its still: longer while the page keeps replacing them. */
  stillAfterMs: number;
  /** When the last still went, until the page moves again. */
  stillSentAt: number | null;
  /** Frames of the page moving: a still taken while one came is dropped. */
  moved: number;
  /** The last moving frame's picture and size: the browser sending it again isn't the page moving. */
  lastPicture: Buffer | null;
  lastSize: { readonly width: number; readonly height: number } | null;
  /** A still's picture is being taken, or was until `capturedAt`: the browser's frames of it aren't the page's. */
  capturing: boolean;
  capturedAt: number;
  stills: number;
};

/** A still the page replaced within this long makes the next wait longer. */
const STILL_KEPT_MS = 2_000;
/** The browser's own frames of a still's picture come while it's taken or just after. */
const CAPTURE_SETTLE_MS = 250;
/** The still's JPEG qualities, tried in turn while the picture is over `previewFrameMaxBytes`. */
const STILL_QUALITIES = [runnerLimits.browserViewStillQuality, 75] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms)).unref();
  });

/** A width of a tablet or less is a finger's (touch, `mobile`), as the presets are. */
export const viewportOf = (viewport: PreviewViewport): Viewport => ({
  width: viewport.width,
  height: viewport.height,
  mobile: viewport.width <= viewportPresetSizes.tablet.width,
});

/** Whether a page ended, read through a function: it ends between awaits, which the type checker doesn't see. */
const endedNow = (shared: Shared): boolean => shared.ended;

const sameViewport = (a: Viewport, b: Viewport): boolean => a.width === b.width && a.height === b.height && a.mobile === b.mobile && (a.scale ?? 1) === (b.scale ?? 1);

/** The page's device pixel ratio: its viewers' highest, for its still frames. */
const stillScaleOf = (shared: Shared): number => browserViewStillScale(Math.max(1, ...[...shared.watchers.values()].map((watcher) => watcher.scale)));

const isJpeg = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** A frame's side in the header: a whole number of pixels the protocol takes. */
const side = (pixels: number): number => Math.min(8192, Math.max(1, Math.round(pixels)));

export const createSharedPages = (deps: SharedPagesDeps): SharedPages => {
  const log = deps.logger.child({ component: "shared-pages" });
  const pages = new Map<PreviewKey, Shared>();
  const byView = new Map<PreviewViewId, Shared>();
  const loadMs = deps.loadMs ?? 30_000;

  /** Sends the page's newest frame to a view that hasn't got it, once the one it has is taken. */
  const offer = (shared: Shared, watcher: Watcher): void => {
    const frame = shared.newest;
    if (frame === null || shared.ended || watcher.sent >= frame.header.seq) {
      return;
    }
    if (watcher.busy) {
      watcher.behind = true;
      return;
    }
    watcher.busy = true;
    watcher.behind = false;
    watcher.sent = frame.header.seq;
    const settle = (took: boolean): void => {
      watcher.busy = false;
      if (shared.watchers.get(watcher.viewId) !== watcher) {
        return;
      }
      if (took) {
        shared.taken += 1;
        // A view has the newest frame: the browser may make the next one.
        if (shared.newest === frame && shared.release !== null) {
          const release = shared.release;
          shared.release = null;
          release();
        }
      }
      if (watcher.behind) {
        offer(shared, watcher);
      }
    };
    watcher.sink.send(frame).then(settle, () => {
      settle(false);
    });
  };

  const cancelStill = (shared: Shared): void => {
    if (shared.stillTimer !== null) {
      clearTimeout(shared.stillTimer);
      shared.stillTimer = null;
    }
  };

  /** The page at rest: its picture at the still quality and its device pixel ratio, to every view, unless it moved meanwhile. */
  const takeStill = async (shared: Shared, moved: number, viewport: Viewport): Promise<void> => {
    const resting = (): boolean => !shared.ended && shared.watchers.size > 0 && shared.moved === moved && shared.viewport === viewport;
    const opened = await shared.opened;
    if (!opened.ok || !resting()) {
      return;
    }
    let picture: Buffer | null = null;
    shared.capturing = true;
    try {
      for (const quality of STILL_QUALITIES) {
        picture = await opened.page.screenshot({ format: "jpeg", quality });
        if (picture.length <= runnerLimits.previewFrameMaxBytes || !resting()) {
          break;
        }
      }
    } catch {
      picture = null;
      log.info("preview.still-failed", { key: shared.key });
    } finally {
      shared.capturing = false;
      shared.capturedAt = Date.now();
    }
    if (picture === null || !resting()) {
      return;
    }
    if (!isJpeg(picture) || picture.length > runnerLimits.previewFrameMaxBytes) {
      // Core would refuse it: the page keeps its last moving frame.
      log.warn("preview.still-skipped", { key: shared.key, bytes: picture.length });
      return;
    }
    shared.seq += 1;
    shared.stills += 1;
    shared.stillSentAt = Date.now();
    const size = shared.lastSize ?? { width: side(viewport.width), height: side(viewport.height) };
    shared.newest = {
      header: { seq: shared.seq, at: Date.now(), width: size.width, height: size.height, still: true },
      jpeg: new Uint8Array(picture.buffer, picture.byteOffset, picture.byteLength),
    };
    for (const watcher of shared.watchers.values()) {
      offer(shared, watcher);
    }
  };

  /** Once the page sends nothing for the wait, its still frame. */
  const armStill = (shared: Shared): void => {
    cancelStill(shared);
    if (shared.ended || shared.watchers.size === 0) {
      return;
    }
    const moved = shared.moved;
    const viewport = shared.viewport;
    const timer = setTimeout(() => {
      shared.stillTimer = null;
      void takeStill(shared, moved, viewport);
    }, shared.stillAfterMs);
    timer.unref();
    shared.stillTimer = timer;
  };

  /**
   * Whether a frame is the page moving: not the browser sending its last picture again, and not a
   * frame of a still's capture (one at the capture's size, while it's taken or just after).
   */
  const moving = (shared: Shared, frame: ScreencastFrame): boolean => {
    if (shared.lastPicture?.equals(frame.data) === true) {
      return false;
    }
    const capture = shared.capturing || Date.now() - shared.capturedAt < CAPTURE_SETTLE_MS;
    return !capture || shared.lastSize === null || (side(frame.width) === shared.lastSize.width && side(frame.height) === shared.lastSize.height);
  };

  /** One frame from the browser: to every view, and its ack held until one took it and the rate's gap passed. */
  const onFrame = async (shared: Shared, frame: ScreencastFrame): Promise<void> => {
    if (shared.ended || shared.watchers.size === 0) {
      return;
    }
    shared.frames += 1;
    if (!isJpeg(frame.data) || frame.data.length > runnerLimits.previewFrameMaxBytes) {
      // Core would refuse it and the view with it: the next frame comes instead.
      log.warn("preview.frame-skipped", { key: shared.key, bytes: frame.data.length });
      return;
    }
    if (!moving(shared, frame)) {
      // Acked at once: the views have this picture, or a sharper one of it.
      return;
    }
    // The page moves: its still waits for it to rest again, and a still it replaced soon makes that wait longer.
    cancelStill(shared);
    shared.moved += 1;
    if (shared.stillSentAt !== null) {
      shared.stillAfterMs = Date.now() - shared.stillSentAt < STILL_KEPT_MS ? Math.min(runnerLimits.browserViewStillAfterMaxMs, shared.stillAfterMs * 2) : runnerLimits.browserViewStillAfterMs;
      shared.stillSentAt = null;
    }
    shared.lastPicture = frame.data;
    shared.lastSize = { width: side(frame.width), height: side(frame.height) };
    shared.seq += 1;
    const current: PreviewFrame = {
      header: { seq: shared.seq, at: Date.now(), width: shared.lastSize.width, height: shared.lastSize.height },
      jpeg: new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
    };
    shared.release?.();
    const taken = new Promise<void>((resolve) => {
      shared.release = resolve;
    });
    shared.newest = current;
    for (const watcher of shared.watchers.values()) {
      offer(shared, watcher);
    }
    await taken;
    // Spike 07: the cap holds the ack until 1/cap s after the last one; with `sendLastFrame` the
    // browser then sends the newest it made, so the last change before a pause isn't lost.
    const gap = 1000 / Math.max(1, deps.framesPerSecond());
    await sleep(shared.lastAckAt + gap - Date.now());
    shared.lastAckAt = Date.now();
    // The ack goes now, so the browser may send the next frame: none for the wait is the page at rest.
    armStill(shared);
  };

  /**
   * The page's screencast, spike 07's: its frames to `onFrame`, each acked once a view took it and
   * the rate's gap passed, at the page's own size (Q326: within the browser view's pixel cap).
   */
  const startCast = (shared: Shared, page: Page): Promise<() => Promise<void>> => {
    const bounds = browserViewFrameBounds(shared.viewport);
    return page.startScreencast(
      {
        format: "jpeg",
        quality: runnerLimits.browserViewQuality,
        maxWidth: bounds.width,
        maxHeight: bounds.height,
        maxFramesInFlight: runnerLimits.browserViewFramesInFlight,
        sendLastFrame: true,
        everyNthFrame: 1,
      },
      (frame) => onFrame(shared, frame),
    );
  };

  /** Opens the page: the box's browser, a page of its own at the first view's width, the preview loaded, the screencast on. */
  const open = async (shared: Shared, path: string): Promise<Opened> => {
    const browser = await deps.browser();
    if (!browser.available) {
      return { ok: false, reason: "no-browser" };
    }
    if (endedNow(shared)) {
      return { ok: false, reason: "detached" };
    }
    let page: Page;
    try {
      page = await openPage(browser.client, shared.viewport);
    } catch {
      return { ok: false, reason: "browser-failed" };
    }
    const closeIt = async (reason: AttachRefusal): Promise<Opened> => {
      await page.close();
      return { ok: false, reason };
    };
    if (endedNow(shared)) {
      return closeIt("detached");
    }
    try {
      await page.guardDocuments((url) => {
        if (deps.mayLoad(url)) {
          return true;
        }
        shared.blocked += 1;
        log.info("preview.page-document-refused", { key: shared.key });
        return false;
      });
    } catch {
      return closeIt("browser-failed");
    }
    try {
      await page.navigate(`${shared.origin}${path}`, loadMs);
    } catch {
      // The app didn't answer, or is slow to: the page shows what it has, and a reload loads it again.
      log.info("preview.page-load-incomplete", { key: shared.key });
    }
    if (endedNow(shared)) {
      return closeIt("detached");
    }
    try {
      shared.stopCast = await startCast(shared, page);
    } catch {
      return closeIt("browser-failed");
    }
    if (endedNow(shared)) {
      await shared.stopCast();
      shared.stopCast = null;
      return closeIt("detached");
    }
    log.info("preview.page-opened", { key: shared.key, views: shared.watchers.size, width: shared.viewport.width });
    return { ok: true, page };
  };

  /** Ends a page: its screencast stops and it closes, and a held ack goes. */
  const end = async (shared: Shared): Promise<void> => {
    if (shared.ended) {
      return;
    }
    shared.ended = true;
    cancelStill(shared);
    if (pages.get(shared.key) === shared) {
      pages.delete(shared.key);
    }
    const release = shared.release;
    shared.release = null;
    release?.();
    const opened = await shared.opened;
    const stop = shared.stopCast;
    shared.stopCast = null;
    await stop?.();
    if (opened.ok) {
      await opened.page.close();
    }
    log.info("preview.page-closed", { key: shared.key, frames: shared.frames, taken: shared.taken, stills: shared.stills });
  };

  /** Runs `work` on the view's page after what came before it, once the page is open. */
  const enqueue = (shared: Shared, work: (page: Page) => Promise<void>): Promise<void> => {
    const next = shared.queue.then(async () => {
      const opened = await shared.opened;
      if (!opened.ok || shared.ended) {
        return;
      }
      await work(opened.page);
    });
    shared.queue = next.catch(() => undefined);
    return shared.queue;
  };

  /** Moves the page to `viewport`'s size, at its viewers' device pixel ratio (`stillScaleOf`). */
  const setViewport = (shared: Shared, viewport: Viewport): Promise<void> =>
    enqueue(shared, async (page) => {
      const next: Viewport = { ...viewport, scale: stillScaleOf(shared) };
      if (sameViewport(shared.viewport, next)) {
        return;
      }
      cancelStill(shared);
      shared.viewport = next;
      await page.setViewport(next);
      // The page at its new size comes as a new screencast's first frame: Chromium can hold the
      // resized page's frame behind the one in flight and send nothing until the page changes again.
      // That frame is the page moving, whatever it shows, so a new scale's still follows it.
      shared.lastPicture = null;
      shared.lastSize = null;
      const stop = shared.stopCast;
      shared.stopCast = null;
      await stop?.();
      const release = shared.release;
      shared.release = null;
      release?.();
      if (!endedNow(shared)) {
        shared.stopCast = await startCast(shared, page);
      }
      log.info("preview.page-viewport", { key: shared.key, width: next.width, scale: next.scale ?? 1 });
    });

  const detach = async (viewId: PreviewViewId): Promise<void> => {
    const shared = byView.get(viewId);
    byView.delete(viewId);
    if (shared?.watchers.delete(viewId) !== true) {
      return;
    }
    if (shared.watchers.size === 0) {
      await end(shared);
      return;
    }
    // A view that goes may have been the one the browser waited on: the others get the newest.
    for (const watcher of shared.watchers.values()) {
      offer(shared, watcher);
    }
    // The page's device pixel ratio is the viewers' who stay.
    void setViewport(shared, shared.viewport);
  };

  return {
    attach: async (input) => {
      let shared = pages.get(input.key);
      const viewport = viewportOf(input.viewport);
      const scale = browserViewStillScale(input.viewport.scale);
      if (shared === undefined || shared.ended) {
        const created: Shared = {
          key: input.key,
          origin: input.origin,
          watchers: new Map(),
          opened: Promise.resolve({ ok: false, reason: "detached" }),
          stopCast: null,
          // The first viewer's device pixel ratio from the start: a page isn't drawn twice to get it.
          viewport: { ...viewport, scale },
          seq: 0,
          newest: null,
          release: null,
          lastAckAt: 0,
          ended: false,
          queue: Promise.resolve(),
          frames: 0,
          taken: 0,
          inputs: 0,
          inputsFailed: 0,
          blocked: 0,
          stillTimer: null,
          stillAfterMs: runnerLimits.browserViewStillAfterMs,
          stillSentAt: null,
          moved: 0,
          lastPicture: null,
          lastSize: null,
          capturing: false,
          capturedAt: 0,
          stills: 0,
        };
        created.opened = open(created, input.path).catch((): Opened => ({ ok: false, reason: "browser-failed" }));
        pages.set(input.key, created);
        shared = created;
      }
      const watcher: Watcher = { viewId: input.viewId, sink: input.sink, busy: false, behind: false, sent: 0, scale };
      shared.watchers.set(input.viewId, watcher);
      byView.set(input.viewId, shared);
      const opened = await shared.opened;
      if (!opened.ok) {
        // The next view opens a page afresh: the browser may start for it.
        if (pages.get(shared.key) === shared) {
          pages.delete(shared.key);
        }
        await detach(input.viewId);
        return { ok: false, reason: opened.reason };
      }
      if (shared.watchers.get(input.viewId) !== watcher) {
        return { ok: false, reason: "detached" };
      }
      // The width is the last one chosen (Q314): a view opened at another width moves the page.
      void setViewport(shared, viewport);
      offer(shared, watcher);
      return { ok: true };
    },
    detach,
    control: async (viewId, control) => {
      const shared = byView.get(viewId);
      if (shared === undefined) {
        return false;
      }
      switch (control.kind) {
        case "viewport": {
          // The width is the last one chosen; the device pixel ratio is this viewer's, when it names one.
          const watcher = shared.watchers.get(viewId);
          if (watcher !== undefined && control.viewport.scale !== undefined) {
            watcher.scale = browserViewStillScale(control.viewport.scale);
          }
          await setViewport(shared, viewportOf(control.viewport));
          return true;
        }
        case "navigate":
          await enqueue(shared, async (page) => {
            await page.go(`${shared.origin}${control.path}`).catch(() => {
              log.info("preview.page-navigate-failed", { key: shared.key });
            });
          });
          return true;
        case "reload":
          await enqueue(shared, (page) => page.reload());
          return true;
        case "input":
          await enqueue(shared, async (page) => {
            const done = await dispatchViewInput(page, control.events);
            shared.inputs += done.applied;
            shared.inputsFailed += done.failed;
          });
          return true;
        default:
          return control satisfies never;
      }
    },
    input: async (viewId, events) => {
      const shared = byView.get(viewId);
      if (shared === undefined) {
        return false;
      }
      await enqueue(shared, async (page) => {
        const done = await dispatchViewInput(page, events);
        shared.inputs += done.applied;
        shared.inputsFailed += done.failed;
      });
      return true;
    },
    pages: () => pages.size,
    hasPage: (key) => pages.has(key),
    counts: (key) => {
      const shared = pages.get(key);
      return shared === undefined
        ? undefined
        : { frames: shared.frames, taken: shared.taken, views: shared.watchers.size, inputs: shared.inputs, inputsFailed: shared.inputsFailed, blocked: shared.blocked, stills: shared.stills };
    },
    evaluate: async (key, expression, schema) => {
      const shared = pages.get(key);
      const opened = shared === undefined ? null : await shared.opened;
      if (opened?.ok !== true) {
        throw new Error("the preview has no page");
      }
      return opened.page.evaluate(expression, schema);
    },
    closeAll: async () => {
      const all = [...pages.values()];
      for (const shared of all) {
        for (const viewId of shared.watchers.keys()) {
          byView.delete(viewId);
        }
        shared.watchers.clear();
      }
      await Promise.all(all.map((shared) => end(shared)));
    },
  };
};
