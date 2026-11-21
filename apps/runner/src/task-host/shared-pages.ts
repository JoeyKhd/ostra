import type { Logger } from "@ostra/adapter-sdk";
import { runnerLimits, viewportPresetSizes } from "@ostra/protocol";
import type { PreviewControl, PreviewInputEvent, PreviewKey, PreviewViewId, PreviewViewport } from "@ostra/protocol";
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
// - **The screencast** (spike 07's defaults): JPEG at quality 60, at most 1440×900, one frame in
//   flight, `sendLastFrame` on. The rate is capped by holding each frame's ack to the browser,
//   never by dropping frames: 15 a second on the WebSocket, 2 on the HTTP carrier. The ack goes
//   back once a view's core took the newest frame, so `maxFramesInFlight` holds the browser to what
//   core takes: a member who reads slowly slows the browser rather than queueing frames in core.
// - **Each view** has at most one frame with its core. A view that's behind gets the newest frame
//   once it took the one it has, so a slow member never holds a fast one back, and a view that
//   joins gets the newest frame at once (a still page sends no new one).
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
};

export type SharedPages = {
  /** Attaches a view to its preview's page, opening the page and its screencast for the first view. */
  readonly attach: (input: AttachInput) => Promise<AttachOutcome>;
  /** Detaches a view; the page closes with its last view. */
  readonly detach: (viewId: PreviewViewId) => Promise<void>;
  /** Applies core's control to the view's page, after what came before it. `false` when the view has no page. */
  readonly control: (viewId: PreviewViewId, control: PreviewControl) => Promise<boolean>;
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
};

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

const sameViewport = (a: Viewport, b: Viewport): boolean => a.width === b.width && a.height === b.height && a.mobile === b.mobile;

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
    shared.seq += 1;
    const current: PreviewFrame = {
      header: { seq: shared.seq, at: Date.now(), width: side(frame.width), height: side(frame.height) },
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
  };

  /** The page's screencast, spike 07's: its frames to `onFrame`, each acked once a view took it and the rate's gap passed. */
  const startCast = (shared: Shared, page: Page): Promise<() => Promise<void>> =>
    page.startScreencast(
      {
        format: "jpeg",
        quality: runnerLimits.browserViewQuality,
        maxWidth: runnerLimits.browserViewMaxWidth,
        maxHeight: runnerLimits.browserViewMaxHeight,
        maxFramesInFlight: runnerLimits.browserViewFramesInFlight,
        sendLastFrame: true,
        everyNthFrame: 1,
      },
      (frame) => onFrame(shared, frame),
    );

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
    log.info("preview.page-closed", { key: shared.key, frames: shared.frames, taken: shared.taken });
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

  const setViewport = (shared: Shared, viewport: Viewport): Promise<void> =>
    enqueue(shared, async (page) => {
      if (sameViewport(shared.viewport, viewport)) {
        return;
      }
      shared.viewport = viewport;
      await page.setViewport(viewport);
      // The page at its new size comes as a new screencast's first frame: Chromium can hold the
      // resized page's frame behind the one in flight and send nothing until the page changes again.
      const stop = shared.stopCast;
      shared.stopCast = null;
      await stop?.();
      const release = shared.release;
      shared.release = null;
      release?.();
      if (!endedNow(shared)) {
        shared.stopCast = await startCast(shared, page);
      }
      log.info("preview.page-viewport", { key: shared.key, width: viewport.width });
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
  };

  return {
    attach: async (input) => {
      let shared = pages.get(input.key);
      const viewport = viewportOf(input.viewport);
      if (shared === undefined || shared.ended) {
        const created: Shared = {
          key: input.key,
          origin: input.origin,
          watchers: new Map(),
          opened: Promise.resolve({ ok: false, reason: "detached" }),
          stopCast: null,
          viewport,
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
        };
        created.opened = open(created, input.path).catch((): Opened => ({ ok: false, reason: "browser-failed" }));
        pages.set(input.key, created);
        shared = created;
      }
      const watcher: Watcher = { viewId: input.viewId, sink: input.sink, busy: false, behind: false, sent: 0 };
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
        case "viewport":
          await setViewport(shared, viewportOf(control.viewport));
          return true;
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
        : { frames: shared.frames, taken: shared.taken, views: shared.watchers.size, inputs: shared.inputs, inputsFailed: shared.inputsFailed, blocked: shared.blocked };
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
