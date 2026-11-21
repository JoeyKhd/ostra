import type { AdapterResult, AppPortReach, Logger } from "@ostra/adapter-sdk";
import { runnerLimits, viewportPresetSizes } from "@ostra/protocol";
import type { PreviewInputEvent, PreviewKey, PreviewMode, PreviewSupport, PreviewTarget, PreviewViewId, PreviewViewport, Reach } from "@ostra/protocol";
import type { WebSocket } from "ws";
import type { OpenBoxBrowser } from "../browser/box-browser.ts";
import type { Carrier } from "../connection/http-carrier.ts";
import type { PreviewConnectionFailure, PreviewConnectionResult } from "../connection/preview-connection.ts";
import type { PreviewFrame, PreviewFramesPost } from "../connection/preview-frames.ts";
import { httpStreamLink, socketStreamLink } from "./preview-stream.ts";
import type { StreamLink } from "./preview-stream.ts";
import { serveTunnel } from "./preview-tunnel.ts";
import type { Tunnel, TunnelRoute } from "./preview-tunnel.ts";
import type { SharedPages } from "./shared-pages.ts";

// A box's open views (milestone 8, ticket 22, ADR 0068): one entry per `preview.open` until its
// `preview.close`, the box's stop, or core closing its connection. While any is open the box's idle
// timer holds (ADR 0068, "How core holds them"): the task run asks `watching()`, and hears when the
// last one closes. A view in `tunnel` mode opens its preview connection and serves HTTP/2 on it
// (`serveTunnel`); each stream's port is checked against the reach rule, and the box's way to it
// (on `docker`, the init's forwarder) is opened on the first stream to that port and closed with
// the view.
//
// Ticket 18 adds the `stream` mode's views (the browser view, F-141) on the same registry: once the
// box's app is ready, a view attaches to its preview's shared page in the box's browser
// (`shared-pages.ts`), and its frames go to core on its own preview connection, or posted over the
// HTTP carrier (`preview-stream.ts`). Every view of one preview shares one page; a box holds at
// most `boxPagesMax` pages, one of them kept for the tools' pictures.
//
// IDs, ports and reasons are logged; never a path, a header or a byte of a stream.

/**
 * What this runner reports it can show of a preview, in `hello` and `status` (minor 7), on every
 * executor alike: the browser view (ticket 18) and the tunnel (ticket 22). The connection reports
 * `tunnel: false` on the HTTP carrier, where the browser view's frames are posted. A box with no
 * browser says so in `app.browser`, which takes its browser view away (ticket 19).
 */
export const RUNNER_PREVIEW_SUPPORT: PreviewSupport = { stream: true, tunnel: true };

/** The shared pages a box's views may hold: one of its `boxPagesMax` stays for the tools' pictures. */
export const STREAM_PAGES_MAX = runnerLimits.boxPagesMax - 1;

/** Where the box's browser opens a preview: its origin in the box, its path, and its target (for the wait on the app). */
export type StreamAim = { readonly origin: string; readonly path: string; readonly target: PreviewTarget };

/** The browser view's side of the registry (ticket 18). */
export type PreviewStreamDeps = {
  /** The box's shared pages, in its browser. */
  readonly pages: SharedPages;
  /** Whether the box has a browser, started on first use: a view of a box with none never connects. */
  readonly browser: () => Promise<OpenBoxBrowser>;
  /** The carrier the box reaches core on now: on HTTP the frames are posted, else they ride the view's connection. */
  readonly carrier: () => Carrier;
  /** Posts a view's frames over the HTTP carrier, with the box's token and the lease epoch. */
  readonly postFrames: (viewId: PreviewViewId, frames: readonly PreviewFrame[]) => Promise<PreviewFramesPost>;
  /** Where the box's browser opens the preview of `key`; `null` when it isn't one of the task's (the reach rule). */
  readonly aim: (key: PreviewKey) => StreamAim | null;
  /** The HTTP carrier's least gap between core's answer and the next post (half a second). */
  readonly httpGapMs?: number;
};

export type PreviewViewsDeps = {
  /** Opens the view's preview connection to core in its mode, with the box's token and the lease epoch. */
  readonly connect: (viewId: PreviewViewId, mode: PreviewMode) => Promise<PreviewConnectionResult>;
  /** The reach rule (`mayReach`): a port of one of the task's previews, never below 1024 or one of the box's own. */
  readonly mayReach: (port: number) => Reach;
  /**
   * Where the box reaches a target's port: the init's forwarder on `docker`, `localhost` on
   * `kubernetes` and `host`, a service by its name on `docker`'s box network.
   */
  readonly reachPort: (target: PreviewTarget, port: number) => Promise<AdapterResult<AppPortReach>>;
  /** Resolves once the target's process isn't starting: a stream to an app that is getting ready waits for it. */
  readonly settled: (target: PreviewTarget) => Promise<void>;
  readonly logger: Logger;
  /** How many times an unreachable core is tried for one view (default 3), and how long apart (default 1 s). */
  readonly connectAttempts?: number;
  readonly connectRetryMs?: number;
  /** The browser view (ticket 18): without it, a `stream` view is dropped at its open. */
  readonly stream?: PreviewStreamDeps;
};

export type PreviewViewOpen = {
  readonly viewId: PreviewViewId;
  readonly key: PreviewKey;
  /** `tunnel` (default) or `stream`, the browser view. */
  readonly mode?: PreviewMode;
  /** The browser view's width preset, which applies to the shared page; desktop when absent. */
  readonly viewport?: PreviewViewport | null;
  /**
   * Whether the box can serve the view: it resolves once the box's app is open, `false` when the
   * box never got ready or the key isn't one of its previews. The view holds the box from the open.
   */
  readonly ready: Promise<boolean>;
};

/** Why the box ends a view: `preview.close` (1000), or the box stopping (1001). */
export type PreviewViewEnd = "closed" | "box-stopping";

export type PreviewViews = {
  /** Holds the view open from now, and opens its connection once `ready` says the box can serve it. */
  readonly open: (input: PreviewViewOpen) => void;
  readonly has: (viewId: PreviewViewId) => boolean;
  /**
   * Whether a `stream` view of `key` may open: the registry serves the browser view, and its
   * preview has a page already or the box holds fewer than `STREAM_PAGES_MAX`.
   */
  readonly mayStream: (key: PreviewKey) => boolean;
  /**
   * A member's input for an open browser view (the HTTP carrier's `preview.input`), applied to its
   * page in order. `false` when no `stream` view of that ID is open.
   */
  readonly input: (viewId: PreviewViewId, events: readonly PreviewInputEvent[]) => boolean;
  /** The carrier a browser view's frames go up on, once it's attached; `null` before, or for a tunnel. */
  readonly streaming: (viewId: PreviewViewId) => StreamLink["carrier"] | null;
  /** Ends a view; `false` when none of that ID is open. */
  readonly close: (viewId: PreviewViewId, end: PreviewViewEnd) => boolean;
  /** Ends every view: the box is stopping. */
  readonly closeAll: (end: PreviewViewEnd) => void;
  /** How many views are open: while any is, the box's idle timer holds. */
  readonly watching: () => number;
  /** Runs `listener` each time the last open view closes. */
  readonly onUnwatched: (listener: () => void) => void;
  /** Forgets every view's way to the box's ports, closing each forwarder: the box restarted under them. */
  readonly forgetReaches: () => void;
  /** A view's tunnel, once its connection is open. */
  readonly tunnel: (viewId: PreviewViewId) => Tunnel | undefined;
};

type View = {
  readonly viewId: PreviewViewId;
  readonly key: PreviewKey;
  readonly mode: PreviewMode;
  readonly viewport: PreviewViewport;
  tunnel: Tunnel | undefined;
  /** A `stream` view's way to core, once it's attached. */
  stream: StreamLink | undefined;
  /** Each port's way in the box, opened on its first stream, by target and port. */
  readonly reaches: Map<string, Promise<AdapterResult<AppPortReach>>>;
  ended: boolean;
};

/** Whether a view ended, read through a function: it ends between awaits, which the type checker doesn't see. */
const endedNow = (view: View): boolean => view.ended;

const closeCodes: Readonly<Record<PreviewViewEnd, number>> = { closed: 1000, "box-stopping": 1001 };
const closeWords: Readonly<Record<PreviewViewEnd, string>> = { closed: "the view closed", "box-stopping": "the box is stopping" };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** A reach's cache key: a service is dialled by its name, anything else at the box's own reach. */
const reachKey = (target: PreviewTarget, port: number): string => `${"service" in target ? `service:${target.service}` : "app"}:${String(port)}`;

const failureWords = (failure: PreviewConnectionFailure): string => {
  switch (failure.kind) {
    case "stale-lease":
      return "stale-lease";
    case "refused":
      return `refused-${String(failure.status)}`;
    case "unreachable":
      return "unreachable";
    default:
      return failure satisfies never;
  }
};

export const createPreviewViews = (deps: PreviewViewsDeps): PreviewViews => {
  const log = deps.logger.child({ component: "preview-views" });
  const views = new Map<PreviewViewId, View>();
  const unwatched: (() => void)[] = [];
  const attempts = deps.connectAttempts ?? 3;
  const retryMs = deps.connectRetryMs ?? 1_000;

  const closeReaches = (view: View): void => {
    for (const pending of view.reaches.values()) {
      void pending.then((reached) => (reached.ok ? reached.value.close() : undefined)).catch(() => undefined);
    }
    view.reaches.clear();
  };

  /** Drops a view that ended: its tunnel and forwarders go, and the box hears when it was the last. */
  const drop = (view: View, end: PreviewViewEnd | null): void => {
    if (view.ended) {
      return;
    }
    view.ended = true;
    if (views.get(view.viewId) === view) {
      views.delete(view.viewId);
    }
    view.tunnel?.close(closeCodes[end ?? "closed"], closeWords[end ?? "closed"]);
    view.stream?.close(closeCodes[end ?? "closed"], end === "box-stopping" ? "box-stopping" : "closed");
    if (view.mode === "stream") {
      void deps.stream?.pages.detach(view.viewId);
    }
    closeReaches(view);
    log.info("preview.view-ended", { viewId: view.viewId, key: view.key, end: end ?? "connection-closed", open: views.size });
    if (views.size === 0) {
      for (const listener of unwatched) {
        listener();
      }
    }
  };

  /** A stream's route in the view: the reach rule, the app getting ready, then the box's way to the port. */
  const route = async (view: View, port: number): Promise<TunnelRoute> => {
    const reach = deps.mayReach(port);
    if (!reach.ok) {
      return { ok: false, status: 403, reason: reach.refusal.reason };
    }
    await deps.settled(reach.target);
    if (endedNow(view)) {
      return { ok: false, status: 503, reason: "view-ended" };
    }
    const key = reachKey(reach.target, port);
    let pending = view.reaches.get(key);
    if (pending === undefined) {
      pending = deps.reachPort(reach.target, port);
      view.reaches.set(key, pending);
    }
    const reached = await pending;
    if (!reached.ok) {
      if (view.reaches.get(key) === pending) {
        view.reaches.delete(key);
      }
      return { ok: false, status: reached.error.code === "invalid-input" ? 403 : 502, reason: reached.error.code };
    }
    if (endedNow(view)) {
      void reached.value.close();
      return { ok: false, status: 503, reason: "view-ended" };
    }
    return { ok: true, dial: { host: reached.value.host, port: reached.value.port } };
  };

  /** The view's preview connection in its mode, tried again while core can't be reached; `null` once the view is dropped. */
  const connectSocket = async (view: View): Promise<WebSocket | null> => {
    for (let attempt = 1; attempt <= attempts && !endedNow(view); attempt += 1) {
      const connected = await deps.connect(view.viewId, view.mode);
      if (connected.ok) {
        if (endedNow(view)) {
          connected.socket.close(closeCodes.closed, closeWords.closed);
          return null;
        }
        log.info("preview.view-connected", { viewId: view.viewId, key: view.key, mode: view.mode, attempt });
        return connected.socket;
      }
      log.info("preview.view-connect-failed", { viewId: view.viewId, attempt, reason: failureWords(connected.failure) });
      if (connected.failure.kind !== "unreachable") {
        break;
      }
      if (attempt < attempts) {
        await sleep(retryMs);
      }
    }
    drop(view, null);
    return null;
  };

  const connectTunnel = async (view: View): Promise<void> => {
    const socket = await connectSocket(view);
    if (socket === null) {
      return;
    }
    const tunnel = serveTunnel({ viewId: view.viewId, socket, route: (port) => route(view, port), logger: deps.logger });
    view.tunnel = tunnel;
    // Core closed it, or the network did: the view is over on this side; core closes it on its own.
    void tunnel.closed.then(() => {
      drop(view, null);
    });
  };

  /**
   * A browser view: its preview is one of the task's (the reach rule), its app is ready (or done
   * trying), the box has a browser; then its way to core (its connection, or the HTTP carrier's
   * posts) and its place on the preview's shared page.
   */
  const connectStream = async (view: View, stream: PreviewStreamDeps | undefined): Promise<void> => {
    const aim = stream?.aim(view.key) ?? null;
    if (stream === undefined || aim === null) {
      log.info("preview.view-refused", { viewId: view.viewId, key: view.key, reason: stream === undefined ? "stream-not-supported" : "not-a-preview" });
      drop(view, null);
      return;
    }
    await deps.settled(aim.target);
    const browser = endedNow(view) ? null : await stream.browser();
    if (browser === null || endedNow(view)) {
      return;
    }
    if (!browser.available) {
      // `app.browser` told core why: it takes the browser view away.
      log.info("preview.view-refused", { viewId: view.viewId, key: view.key, reason: "no-browser" });
      drop(view, null);
      return;
    }
    let link: StreamLink;
    if (stream.carrier() === "http") {
      link = httpStreamLink({
        viewId: view.viewId,
        post: (frames) => stream.postFrames(view.viewId, frames),
        onEnd: () => {
          drop(view, null);
        },
        logger: deps.logger,
        ...(stream.httpGapMs === undefined ? {} : { gapMs: stream.httpGapMs }),
      });
      log.info("preview.view-connected", { viewId: view.viewId, key: view.key, mode: view.mode, carrier: "http" });
    } else {
      const socket = await connectSocket(view);
      if (socket === null) {
        return;
      }
      link = socketStreamLink({
        viewId: view.viewId,
        socket,
        onControl: async (control) => {
          await stream.pages.control(view.viewId, control);
        },
        onEnd: () => {
          drop(view, null);
        },
        logger: deps.logger,
      });
    }
    view.stream = link;
    if (endedNow(view)) {
      link.close(closeCodes.closed, "closed");
      return;
    }
    const attached = await stream.pages.attach({ viewId: view.viewId, key: view.key, origin: aim.origin, path: aim.path, viewport: view.viewport, sink: link.sink });
    if (!attached.ok && !endedNow(view)) {
      log.info("preview.view-refused", { viewId: view.viewId, key: view.key, reason: attached.reason });
      drop(view, null);
    }
  };

  /** The keys of the box's open `stream` views: each holds one shared page. */
  const streamKeys = (): Set<PreviewKey> => new Set([...views.values()].filter((view) => view.mode === "stream").map((view) => view.key));

  return {
    open: (input) => {
      if (views.has(input.viewId)) {
        return;
      }
      const mode = input.mode ?? "tunnel";
      const view: View = {
        viewId: input.viewId,
        key: input.key,
        mode,
        viewport: input.viewport ?? viewportPresetSizes.desktop,
        tunnel: undefined,
        stream: undefined,
        reaches: new Map(),
        ended: false,
      };
      views.set(input.viewId, view);
      log.info("preview.view-opened", { viewId: input.viewId, key: input.key, mode, open: views.size });
      void input.ready
        .then((ready) => {
          if (!ready) {
            log.info("preview.view-refused", { viewId: input.viewId, key: input.key, reason: "not-servable" });
            drop(view, null);
            return undefined;
          }
          return mode === "stream" ? connectStream(view, deps.stream) : connectTunnel(view);
        })
        .catch(() => {
          drop(view, null);
        });
    },
    has: (viewId) => views.has(viewId),
    mayStream: (key) => {
      if (deps.stream === undefined) {
        return false;
      }
      const keys = streamKeys();
      return keys.has(key) || keys.size < STREAM_PAGES_MAX;
    },
    input: (viewId, events) => {
      const view = views.get(viewId);
      const stream = deps.stream;
      if (view?.mode !== "stream" || stream === undefined) {
        return false;
      }
      void stream.pages.input(viewId, events);
      return true;
    },
    streaming: (viewId) => views.get(viewId)?.stream?.carrier ?? null,
    close: (viewId, end) => {
      const view = views.get(viewId);
      if (view === undefined) {
        return false;
      }
      drop(view, end);
      return true;
    },
    closeAll: (end) => {
      for (const view of [...views.values()]) {
        drop(view, end);
      }
    },
    watching: () => views.size,
    onUnwatched: (listener) => {
      unwatched.push(listener);
    },
    forgetReaches: () => {
      for (const view of views.values()) {
        closeReaches(view);
      }
    },
    tunnel: (viewId) => views.get(viewId)?.tunnel,
  };
};
