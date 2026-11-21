import type { AdapterResult, AppPortReach, Logger } from "@ostra/adapter-sdk";
import type { PreviewKey, PreviewSupport, PreviewTarget, PreviewViewId, Reach } from "@ostra/protocol";
import type { PreviewConnectionFailure, PreviewConnectionResult } from "../connection/preview-connection.ts";
import { serveTunnel } from "./preview-tunnel.ts";
import type { Tunnel, TunnelRoute } from "./preview-tunnel.ts";

// A box's open views (milestone 8, ticket 22, ADR 0068): one entry per `preview.open` until its
// `preview.close`, the box's stop, or core closing its connection. While any is open the box's idle
// timer holds (ADR 0068, "How core holds them"): the task run asks `watching()`, and hears when the
// last one closes. A view in `tunnel` mode opens its preview connection and serves HTTP/2 on it
// (`serveTunnel`); each stream's port is checked against the reach rule, and the box's way to it
// (on `docker`, the init's forwarder) is opened on the first stream to that port and closed with
// the view. Ticket 18 adds the `stream` mode's views on the same registry.
//
// IDs, ports and reasons are logged; never a path, a header or a byte of a stream.

/**
 * What this runner reports it can show of a preview, in `hello` and `status` (minor 7), on every
 * executor alike: the tunnel (ticket 22), and not yet the browser view (ticket 18). The connection
 * reports `tunnel: false` on the HTTP carrier.
 */
export const RUNNER_PREVIEW_SUPPORT: PreviewSupport = { stream: false, tunnel: true };

export type PreviewViewsDeps = {
  /** Opens the view's preview connection to core in `tunnel` mode, with the box's token and the lease epoch. */
  readonly connect: (viewId: PreviewViewId) => Promise<PreviewConnectionResult>;
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
};

export type PreviewViewOpen = {
  readonly viewId: PreviewViewId;
  readonly key: PreviewKey;
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
  tunnel: Tunnel | undefined;
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

  const connect = async (view: View): Promise<void> => {
    for (let attempt = 1; attempt <= attempts && !endedNow(view); attempt += 1) {
      const connected = await deps.connect(view.viewId);
      if (connected.ok) {
        if (endedNow(view)) {
          connected.socket.close(closeCodes.closed, closeWords.closed);
          return;
        }
        const tunnel = serveTunnel({ viewId: view.viewId, socket: connected.socket, route: (port) => route(view, port), logger: deps.logger });
        view.tunnel = tunnel;
        log.info("preview.view-connected", { viewId: view.viewId, key: view.key, attempt });
        // Core closed it, or the network did: the view is over on this side; core closes it on its own.
        void tunnel.closed.then(() => {
          drop(view, null);
        });
        return;
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
  };

  return {
    open: (input) => {
      if (views.has(input.viewId)) {
        return;
      }
      const view: View = { viewId: input.viewId, key: input.key, tunnel: undefined, reaches: new Map(), ended: false };
      views.set(input.viewId, view);
      log.info("preview.view-opened", { viewId: input.viewId, key: input.key, mode: "tunnel", open: views.size });
      void input.ready
        .then((ready) => {
          if (!ready) {
            log.info("preview.view-refused", { viewId: input.viewId, key: input.key, reason: "not-servable" });
            drop(view, null);
            return undefined;
          }
          return connect(view);
        })
        .catch(() => {
          drop(view, null);
        });
    },
    has: (viewId) => views.has(viewId),
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
