import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { constants as http2Constants } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { spliceStreams } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  closeView,
  createPreviewCookies,
  heartbeatView,
  isPreviewDomainHost,
  NATIVE_RECHECK_MS,
  nativeViewFor,
  parsePreviewHost,
  PREVIEW_CHECK_HEADER,
  PREVIEW_CHECK_PATH,
  PREVIEW_ENTER_PATH,
  PREVIEW_HEARTBEAT_MS,
  previewCheckMark,
  previewCookieClears,
  previewCookieHeader,
  previewCookieSameSite,
  previewCookieValue,
  previewOriginOf,
  previewRedirectPath,
  previewSiteLayout,
  previewViewInTx,
  recordPreviewFraming,
  redeemNativeEntry,
  REPLICA_SIGNATURE_HEADER,
  rewriteRequest,
  rewriteResponse,
  signReplicaRequest,
  verifyReplicaRequest,
} from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, HeaderMap, NativeView, NativeViewResult, PreviewCookieClaims, PreviewCookies, PreviewHostKey } from "@ostra/domain";
import { previewTunnel, previewViewIdSchema } from "@ostra/protocol";
import type { PreviewId, PreviewViewId } from "@ostra/protocol";

import type { TunnelHub } from "./tunnels.ts";

// The native preview's proxy (milestone 8, ticket 25, F-144, ADR 0068 "The native preview"). When
// `OSTRA_PREVIEW_DOMAIN` is set, core's server hands every request and upgrade whose `Host` is under
// the domain here, and to nothing else (`server.ts`); unset, none of this is built.
//
// - **The handshake:** `GET /.ostra/enter?code=…&path=…` on a preview host redeems the one-time code
//   the panel minted (`redeemNativeEntry`: single use, 60 s, bound to the viewer, the task, the port
//   and the lease epoch, and to the host's preview ID and port), sets `__Host-ostra-preview`
//   (host-only, `Secure; HttpOnly`; `SameSite=None; Partitioned` in a frame on another site than the
//   panel's, `Lax` in a tab or on the panel's site, by the browser's own `Sec-Fetch-Site` and
//   `Sec-Fetch-Dest`, with the install's site layout where it sends neither (Q325); at most 12
//   hours, the member's session or the link), and redirects to the path.
// - **Every request** needs that cookie (an HMAC under the secrets key), for the host it names.
//   Without one, the host answers a small page that says to open the preview from ostra, and
//   nothing of the app. On each new connection and every 5 minutes core checks the viewer and the
//   lease again (`nativeViewFor`), which answers the viewer's `native` view on the task's lease, or
//   opens one, so a reopen's new lease is picked up by the same host.
// - **The rewrites:** `rewriteRequest` (the strips, no member identity, the `Origin` check on an
//   upgrade, `Host` and `Origin` to `localhost` unless the app process turns `hostRewrite` off, an
//   outside link's `Origin` kept) and `rewriteResponse` (`X-Frame-Options` removed,
//   `frame-ancestors` the panel's origin only, `Location` back to the preview host).
// - **The bytes:** each request is an HTTP/2 request on the view's tunnel session
//   (`TunnelHub.session`), and each WebSocket an RFC 8441 extended CONNECT, answered with core's own
//   `Sec-WebSocket-Accept`. Only the replica that holds the box's connection has that session: any
//   other forwards the request (and an upgrade) there, signed under the secrets key, on
//   `/replica/v1/native/…`, which a replica serves from its own session only, never forwarding again.
// - **Warm while used:** while the member's browser has a request or a socket on a view, the replica
//   that has it heartbeats the view every 30 s, as an open `ostra preview` does (ticket 23), up to
//   the same warm cap.
// - `/.ostra/check` on any host under the domain answers the instance's check with this install's
//   mark (`previewCheckMark`), and takes a WebSocket upgrade.
//
// Never logged: a code, a cookie, a path, a header's value, a byte. Logged: IDs, ports and reasons.

export type NativePreviewsDeps = {
  readonly db: Db;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: {
    /** `OSTRA_PREVIEW_DOMAIN`, lower-case. */
    readonly domain: string;
    /** `OSTRA_PUBLIC_URL`: the one origin that may frame a preview, and the site layout a handshake falls back on. */
    readonly publicUrl: string;
    /** `OSTRA_CORE_PUBLIC_URL`: preview hosts are served on its scheme and port. */
    readonly corePublicUrl: string;
    readonly warmMinutes: number;
  };
  readonly tunnels: TunnelHub;
  /** The secrets key's text: the cookie, the check's mark and the replicas' signatures. */
  readonly secret: () => Promise<string>;
  /** This replica's internal address (`OSTRA_CORE_REPLICA_URL`). */
  readonly replicaUrl: () => string;
  /** How long a request waits for the box's connection to reach a replica *(working value)*. */
  readonly presenceWaitMs: number;
  /** How often a used view is heartbeated: 30 s (tests shorten it). */
  readonly heartbeatMs?: number;
  /** How often a cookie's viewer and lease are checked again: 5 minutes (tests shorten it). */
  readonly recheckMs?: number;
};

export type NativePreviews = {
  /** Whether `host` is the preview domain or under it: then only this answers it. */
  readonly takes: (host: string | undefined) => boolean;
  readonly handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Another replica's forwarded native request, on core's own host; `false` for any other path. */
  readonly handleForwarded: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean>;
  /** Another replica's forwarded native upgrade; `false` for any other path. */
  readonly handleForwardedUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** The grants this replica keeps, for tests: each one's checks so far, and its view. */
  readonly grants: () => readonly { readonly grantId: string; readonly checks: number; readonly viewId: PreviewViewId | null; readonly sockets: number }[];
  readonly start: () => void;
  readonly stop: () => void;
};

/** The path a replica forwards a native request on: `<prefix><viewId>/<port>/<authority, base64url><the path>`. */
export const NATIVE_FORWARD_PREFIX = "/replica/v1/native/";

/** Marks a forwarded request's answer that the replica made itself, not the app. */
const REPLICA_REFUSED_HEADER = "x-ostra-replica-refused";

/** HTTP/2 refuses connection-specific headers (RFC 9113 §8.2.2): each hop drops them. */
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "http2-settings"]);

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** A request's headers as a header map: lower-case names, defined values, no pseudo-headers. */
const headerMapOf = (headers: IncomingHttpHeaders): HeaderMap => {
  const out: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !name.startsWith(":")) {
      out[name] = value;
    }
  }
  return out;
};

/** A header map as outgoing headers, without the hop-by-hop ones, core's own (`x-ostra-*`) and `drop`. */
const outgoingOf = (headers: HeaderMap, drop: readonly string[] = []): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (hopByHop.has(name) || drop.includes(name) || name.startsWith(":") || name.startsWith("x-ostra-")) {
      continue;
    }
    out[name] = typeof value === "string" ? value : [...value];
  }
  return out;
};

/** The app's port and the `:authority` a rewritten request goes to the box with (ticket 22's port header when it isn't `localhost:<port>`). */
const authorityOf = (headers: HeaderMap, port: number): { readonly authority: string; readonly portHeader: boolean } => {
  const host = headers["host"];
  const authority = typeof host === "string" ? host : previewTunnel.authority(port);
  return { authority, portHeader: authority !== previewTunnel.authority(port) };
};

/** The box's HTTP/2 answer as a header map, without its pseudo-headers. */
const answerMapOf = (headers: Readonly<Record<string, unknown>>): HeaderMap => {
  const out: Record<string, string | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(":")) {
      continue;
    }
    if (typeof value === "string") {
      out[name] = value;
    } else if (typeof value === "number") {
      out[name] = String(value);
    } else if (Array.isArray(value)) {
      out[name] = value.filter((item): item is string => typeof item === "string");
    }
  }
  return out;
};

const websocketAccept = (key: string): string => createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");

/** The 101 a browser's WebSocket gets, with what the app chose. */
const switchingLines = (accept: string, protocol: string | undefined, extensions: string | undefined): string =>
  [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
    ...(extensions === undefined ? [] : [`Sec-WebSocket-Extensions: ${extensions}`]),
    "",
    "",
  ].join("\r\n");

const reasonPhrases: Readonly<Record<number, string>> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 502: "Bad Gateway", 503: "Service Unavailable" };

/** Refuses an upgrade with a bare status. */
const refuseUpgrade = (socket: Duplex, status: number): void => {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${String(status)} ${reasonPhrases[status] ?? "Refused"}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
  }
};

// ---------- the small page a preview host answers without a good cookie ----------

type PageKind = "open-from-ostra" | "code-used" | "not-running" | "no-answer" | "not-found" | "bad-request";

const pageWords: Readonly<Record<PageKind, string>> = {
  "open-from-ostra": "Open this preview from ostra.",
  "code-used": "This link to the preview has been used or has expired. Open the preview from ostra again.",
  "not-running": "This task's app isn't running now. Start it from ostra, then open the preview again.",
  "no-answer": "The task's box didn't answer in time. Try again in a moment.",
  "not-found": "There's no preview here. Open the preview from ostra.",
  "bad-request": "This request can't be served. Open the preview from ostra.",
};

const pageHtml = (kind: PageKind): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ostra preview</title></head><body style="font:15px/1.5 system-ui,sans-serif;margin:2rem"><p>${pageWords[kind]}</p></body></html>`;

// ---------- a cookie's grant on this replica ----------

type Grant = {
  readonly id: string;
  readonly claims: PreviewCookieClaims;
  /** The bare host it was checked for, and that host's preview ID. */
  readonly host: string;
  readonly previewId: PreviewId;
  view: NativeView | null;
  /** When it was last checked (`Date.now()`), and how many times. */
  checkedAt: number;
  checks: number;
  checking: Promise<NativeViewResult> | null;
  /** The replica that holds `view`'s box connection, and when that was read. */
  holder: { readonly viewId: PreviewViewId; readonly url: string; readonly at: number } | null;
  lastUse: number;
  active: number;
  /** The browser's WebSockets on it, each with the view it rides. */
  readonly sockets: Map<Duplex, PreviewViewId>;
};

type Located =
  | { readonly at: "here"; readonly session: ClientHttp2Session }
  | { readonly at: "replica"; readonly url: string }
  /** Not connected yet, within the wait. */
  | { readonly at: "none" }
  | { readonly at: "closed" }
  /** Connected once, and gone. */
  | { readonly at: "lost" };

type Ready = { readonly ok: true; readonly grant: Grant; readonly view: NativeView; readonly where: Extract<Located, { readonly at: "here" | "replica" }> };
type Refused = { readonly ok: false; readonly status: 401 | 403 | 404 | 503; readonly page: PageKind; readonly clearCookie: boolean };

export const createNativePreviews = (deps: NativePreviewsDeps): NativePreviews => {
  const logger = deps.logger.child({ component: "native-preview" });
  const { domain, publicUrl, corePublicUrl } = deps.settings;
  const layout = previewSiteLayout(publicUrl, domain);
  const origin = previewOriginOf(corePublicUrl);
  const panelOrigin = new URL(publicUrl).origin;
  const heartbeatMs = deps.heartbeatMs ?? PREVIEW_HEARTBEAT_MS;
  const recheckMs = deps.recheckMs ?? NATIVE_RECHECK_MS;
  const viewDeps = { db: deps.db, outbox: deps.outbox, notices: deps.notices, clock: deps.clock, settings: { warmMinutes: deps.settings.warmMinutes } };
  const grants = new Map<string, Grant>();
  /** The grants each connection has been checked for: a new connection is checked again. */
  const seen = new WeakMap<Socket, Set<string>>();
  let cookies: Promise<PreviewCookies> | undefined;
  const cookiesOnce = (): Promise<PreviewCookies> => (cookies ??= deps.secret().then((secret) => createPreviewCookies(secret)));
  let ticker: ReturnType<typeof setInterval> | undefined;

  const page = (response: ServerResponse, status: number, kind: PageKind, clear: boolean): void => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const body = pageHtml(kind);
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${panelOrigin}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(clear ? { "set-cookie": [...previewCookieClears()] } : {}),
    });
    response.end(body);
  };

  // ---------- the checks ----------

  /** Checks the grant's viewer and lease against the rows, once at a time; a refusal for good closes its view. */
  const check = (grant: Grant): Promise<NativeViewResult> =>
    (grant.checking ??= (async (): Promise<NativeViewResult> => {
      try {
        const result = await nativeViewFor(viewDeps, grant.claims, grant.previewId);
        grant.checkedAt = Date.now();
        grant.checks += 1;
        const before = grant.view;
        if (result.ok) {
          if (before !== null && before.viewId !== result.view.viewId) {
            // The lease moved on (a reopen): the old view and its sockets end, and the new view takes over.
            endSockets(grant, before.viewId);
            grant.holder = null;
            await closeView(deps, { viewId: before.viewId, reason: "box-gone" });
          }
          grant.view = result.view;
          if (result.view.opened) {
            logger.info("preview.native-view-opened", { viewId: result.view.viewId, taskId: result.view.taskId, port: result.view.port });
          }
          return result;
        }
        logger.info("preview.native-refused", { taskId: grant.claims.taskId, reason: result.reason });
        grant.view = null;
        grant.holder = null;
        endSockets(grant, null);
        if (result.kind === "gone" && before !== null) {
          await closeView(deps, { viewId: before.viewId, reason: grant.claims.viewer.kind === "link" ? "link-ended" : "closed" });
        }
        return result;
      } finally {
        grant.checking = null;
      }
    })());

  /** Ends the browser's sockets on the grant: those on `viewId`, or all of them. */
  const endSockets = (grant: Grant, viewId: PreviewViewId | null): void => {
    for (const [socket, on] of grant.sockets) {
      if (viewId === null || on === viewId) {
        socket.destroy();
        grant.sockets.delete(socket);
      }
    }
  };

  const refusalOf = (result: Exclude<NativeViewResult, { readonly ok: true }>): Refused => {
    switch (result.kind) {
      case "gone":
        return { ok: false, status: 401, page: "open-from-ostra", clearCookie: true };
      case "not-running":
        return { ok: false, status: 503, page: "not-running", clearCookie: false };
      case "not-a-preview":
        return { ok: false, status: 404, page: "not-found", clearCookie: false };
      default:
        return result satisfies never;
    }
  };

  /** Where the view's box connection is: here, on another replica, nowhere yet (within the wait), or closed. */
  const locate = async (grant: Grant, view: NativeView): Promise<Located> => {
    const deadline = Date.now() + deps.presenceWaitMs;
    for (;;) {
      const session = deps.tunnels.session(view.viewId);
      if (session !== null) {
        return { at: "here", session };
      }
      if (grant.holder?.viewId === view.viewId && Date.now() - grant.holder.at < 5_000) {
        return { at: "replica", url: grant.holder.url };
      }
      const row = await previewViewInTx(deps.db, view.viewId);
      if (row === null || row.lifecycle.state === "closed") {
        return { at: "closed" };
      }
      if (row.lifecycle.state === "open" && row.replicaUrl === null) {
        // The box's connection reached a replica once and is gone (a stale lease, the box gone):
        // the box opens no view's connection again, so this view is done.
        return { at: "lost" };
      }
      const me = deps.replicaUrl();
      if (row.replicaUrl !== null && row.replicaUrl !== me) {
        grant.holder = { viewId: view.viewId, url: row.replicaUrl, at: Date.now() };
        return { at: "replica", url: row.replicaUrl };
      }
      if (Date.now() >= deadline) {
        return { at: "none" };
      }
      await (row.replicaUrl === me ? deps.tunnels.waitForSession(view.viewId, 100) : sleep(100));
    }
  };

  /** The cookie's grant for this host, checked as the rules ask, and where its view's box is. */
  const ready = async (request: IncomingMessage, host: string, key: PreviewHostKey): Promise<Ready | Refused> => {
    const value = previewCookieValue(request.headers.cookie);
    const claims = value === null ? null : (await cookiesOnce()).verify(value, deps.clock.now());
    if (claims?.port !== key.port) {
      return { ok: false, status: 401, page: "open-from-ostra", clearCookie: value !== null };
    }
    let grant = grants.get(claims.grantId);
    if (grant?.host !== host || grant.previewId !== key.previewId) {
      grant = { id: claims.grantId, claims, host, previewId: key.previewId, view: null, checkedAt: 0, checks: 0, checking: null, holder: null, lastUse: Date.now(), active: 0, sockets: new Map() };
      grants.set(claims.grantId, grant);
    }
    grant.lastUse = Date.now();
    const connection = request.socket;
    const known = seen.get(connection) ?? new Set<string>();
    seen.set(connection, known);
    const fresh = grant.view !== null && known.has(grant.id) && Date.now() - grant.checkedAt < recheckMs;
    if (!fresh) {
      const result = await check(grant);
      if (!result.ok) {
        return refusalOf(result);
      }
      known.add(grant.id);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = grant.view;
      if (view === null) {
        return { ok: false, status: 401, page: "open-from-ostra", clearCookie: false };
      }
      const where = await locate(grant, view);
      switch (where.at) {
        case "here":
        case "replica":
          return { ok: true, grant, view, where };
        case "none":
          return { ok: false, status: 503, page: "no-answer", clearCookie: false };
        case "lost":
        case "closed": {
          // The view closed (the sweep), or its box connection went (a stale lease): the check opens
          // the next one, on the task's lease now, under the same preview host.
          if (where.at === "lost") {
            await closeView(deps, { viewId: view.viewId, reason: "box-gone" });
          }
          grant.holder = null;
          const again = await check(grant);
          if (!again.ok) {
            return refusalOf(again);
          }
          break;
        }
        default:
          return where satisfies never;
      }
    }
    return { ok: false, status: 503, page: "no-answer", clearCookie: false };
  };

  // ---------- the handshake and the check ----------

  const enter = async (request: IncomingMessage, response: ServerResponse, url: URL, host: string, key: PreviewHostKey): Promise<void> => {
    if (request.method !== "GET") {
      page(response, 405, "bad-request", false);
      return;
    }
    const entered = await redeemNativeEntry({ db: deps.db, clock: deps.clock }, { previewId: key.previewId, port: key.port, code: url.searchParams.get("code") ?? "" });
    if (!entered.ok) {
      logger.info("preview.native-enter-refused", { reason: entered.reason, port: key.port });
      page(response, entered.reason === "no-preview" ? 404 : 403, entered.reason === "no-preview" ? "not-found" : "code-used", false);
      return;
    }
    const issuer = await cookiesOnce();
    const claims: PreviewCookieClaims = { ...entered.entry, grantId: issuer.newGrantId() };
    const maxAge = (claims.expiresAt - deps.clock.now()) / 1000;
    // The browser reads "site" by the real public suffix list: its `cross-site` is always taken.
    const cookie = previewCookieSameSite({ site: first(request.headers["sec-fetch-site"]), dest: first(request.headers["sec-fetch-dest"]) }, layout);
    response.writeHead(302, {
      "set-cookie": previewCookieHeader(issuer.issue(claims), cookie.sameSite, maxAge),
      location: previewRedirectPath(url.searchParams.get("path")),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-length": "0",
    });
    response.end();
    logger.info("preview.native-entered", { taskId: claims.taskId, port: claims.port, viewer: claims.viewer.kind, sameSite: cookie.sameSite, site: cookie.site, readBy: cookie.readBy });
    // The view opens now, so the box connects while the browser follows the redirect.
    const grant: Grant = { id: claims.grantId, claims, host, previewId: key.previewId, view: null, checkedAt: 0, checks: 0, checking: null, holder: null, lastUse: Date.now(), active: 0, sockets: new Map() };
    grants.set(claims.grantId, grant);
    check(grant).catch((error: unknown) => {
      logger.warn("preview.native-check-failed", { error: error instanceof Error ? error.name : "unknown" });
    });
  };

  const answerCheck = async (response: ServerResponse, host: string): Promise<void> => {
    const body = "ostra preview proxy\n";
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "cache-control": "no-store",
      [PREVIEW_CHECK_HEADER]: previewCheckMark(await deps.secret(), host),
    });
    response.end(body);
  };

  // ---------- a request ----------

  /** The request's path and query, as the browser sent it. */
  const pathOf = (request: IncomingMessage): string => {
    const url = new URL(request.url ?? "/", "http://preview.invalid");
    return `${url.pathname}${url.search}`;
  };

  /** The views whose framing header is recorded already: the pane's notice needs it once (ticket 26). */
  const framed = new Set<PreviewViewId>();

  /** Sends the box's answer on to the browser, rewritten, and records a framing header it replaced. */
  const answer = (response: ServerResponse, status: number, headers: HeaderMap, view: NativeView, host: string): void => {
    const rewritten = rewriteResponse(headers, { panelOrigin, previewHost: host, port: view.port, scheme: origin.scheme });
    response.writeHead(status, outgoingOf(rewritten.headers));
    const framing = rewritten.framing;
    if (framing !== null && !framed.has(view.viewId)) {
      // A bounded memory: the row itself keeps the first header, so forgetting only costs a write.
      if (framed.size >= 4_096) {
        framed.clear();
      }
      framed.add(view.viewId);
      // The app's own header, kept for the pane's notice; never logged.
      recordPreviewFraming(deps.db, view.viewId, framing).catch((error: unknown) => {
        framed.delete(view.viewId);
        logger.warn("preview.native-framing-not-recorded", { viewId: view.viewId, error: error instanceof Error ? error.name : "unknown" });
      });
    }
  };

  const proxyHere = (session: ClientHttp2Session, request: IncomingMessage, response: ServerResponse, headers: HeaderMap, view: NativeView, host: string): Promise<void> =>
    new Promise((resolve) => {
      const { authority, portHeader } = authorityOf(headers, view.port);
      let stream: ClientHttp2Stream;
      try {
        stream = session.request({
          ...outgoingOf(headers),
          ...(portHeader ? { [previewTunnel.portHeader]: String(view.port) } : {}),
          ":method": request.method ?? "GET",
          ":path": pathOf(request),
          ":scheme": "http",
          ":authority": authority,
        });
      } catch {
        page(response, 502, "no-answer", false);
        resolve();
        return;
      }
      stream.on("error", () => {
        if (response.headersSent) {
          response.destroy();
        } else {
          page(response, 502, "no-answer", false);
        }
        resolve();
      });
      stream.on("response", (reply) => {
        answer(response, reply[":status"] ?? 502, answerMapOf(reply), view, host);
        stream.pipe(response);
      });
      stream.on("close", resolve);
      response.on("close", () => {
        if (!stream.closed) {
          stream.close(http2Constants.NGHTTP2_CANCEL);
        }
        resolve();
      });
      request.pipe(stream);
    });

  /** The forwarded path: the view, the port and the `:authority` under the signature, then the browser's path. */
  const forwardPath = (view: NativeView, authority: string, path: string): string =>
    `${NATIVE_FORWARD_PREFIX}${encodeURIComponent(view.viewId)}/${String(view.port)}/${Buffer.from(authority, "utf8").toString("base64url")}${path}`;

  /** Where a forwarded request goes, and the path as it's sent, which the signature covers. */
  const sendTo = (target: string, path: string) => {
    const url = new URL(path, target);
    return { url, signed: `${url.pathname}${url.search}`, send: url.protocol === "https:" ? httpsRequest : httpRequest };
  };

  /** Forwards the request to the replica that holds the view's box connection. `false` when that replica didn't hold it. */
  const proxyThere = async (target: string, request: IncomingMessage, response: ServerResponse, headers: HeaderMap, view: NativeView, host: string): Promise<boolean> => {
    const method = request.method ?? "GET";
    const { authority } = authorityOf(headers, view.port);
    const { url, signed, send } = sendTo(target, forwardPath(view, authority, pathOf(request)));
    const signature = signReplicaRequest(await deps.secret(), { method, path: signed, viewId: view.viewId, at: Date.now() });
    return new Promise((resolve) => {
      const upstream = send(url, { method, headers: { ...outgoingOf(headers), [REPLICA_SIGNATURE_HEADER]: signature } }, (reply) => {
        if (reply.headers[REPLICA_REFUSED_HEADER] !== undefined) {
          reply.resume();
          resolve(false);
          return;
        }
        answer(response, reply.statusCode ?? 502, headerMapOf(reply.headers), view, host);
        reply.pipe(response);
        reply.on("end", () => {
          resolve(true);
        });
        reply.on("error", () => {
          response.destroy();
          resolve(true);
        });
      });
      upstream.on("error", () => {
        logger.warn("preview.native-forward-failed", { viewId: view.viewId });
        resolve(false);
      });
      response.on("close", () => {
        upstream.destroy();
        resolve(true);
      });
      request.pipe(upstream);
    });
  };

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = (request.headers.host ?? "").toLowerCase();
    const url = new URL(request.url ?? "/", "http://preview.invalid");
    if (url.pathname === PREVIEW_CHECK_PATH) {
      await answerCheck(response, host);
      return;
    }
    const key = parsePreviewHost(host, domain);
    if (key === null) {
      page(response, 404, "not-found", false);
      return;
    }
    if (url.pathname === PREVIEW_ENTER_PATH) {
      await enter(request, response, url, host, key);
      return;
    }
    const got = await ready(request, host, key);
    if (!got.ok) {
      page(response, got.status, got.page, got.clearCookie);
      return;
    }
    const rewritten = rewriteRequest(headerMapOf(request.headers), { port: got.view.port, previewHost: host, hostRewrite: got.view.hostRewrite, outsideLink: got.view.outsideLink, scheme: origin.scheme });
    if (!rewritten.ok) {
      page(response, 403, "bad-request", false);
      return;
    }
    const grant = got.grant;
    grant.active += 1;
    try {
      if (got.where.at === "here") {
        await proxyHere(got.where.session, request, response, rewritten.headers, got.view, host);
        return;
      }
      if (!(await proxyThere(got.where.url, request, response, rewritten.headers, got.view, host))) {
        grant.holder = null;
        page(response, 503, "no-answer", false);
      }
    } finally {
      grant.active -= 1;
      grant.lastUse = Date.now();
    }
  };

  // ---------- a WebSocket ----------

  /** The check path's upgrade: 101, then a close frame. */
  const answerCheckUpgrade = (request: IncomingMessage, socket: Duplex): void => {
    const key = first(request.headers["sec-websocket-key"]);
    if (key === undefined) {
      refuseUpgrade(socket, 400);
      return;
    }
    socket.write(switchingLines(websocketAccept(key), undefined, undefined));
    socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
  };

  /** Opens the extended CONNECT on `session` and joins it to the browser's socket. */
  const upgradeOn = (session: ClientHttp2Session, socket: Duplex, head: Buffer, headers: HeaderMap, port: number, path: string, key: string, onOpen: () => void): void => {
    const { authority, portHeader } = authorityOf(headers, port);
    let stream: ClientHttp2Stream;
    try {
      stream = session.request({
        ...outgoingOf(headers, ["sec-websocket-key"]),
        ...(portHeader ? { [previewTunnel.portHeader]: String(port) } : {}),
        ":method": "CONNECT",
        ":protocol": "websocket",
        ":scheme": "http",
        ":path": path,
        ":authority": authority,
      });
    } catch {
      refuseUpgrade(socket, 502);
      return;
    }
    stream.on("error", () => {
      socket.destroy();
    });
    socket.on("close", () => {
      if (!stream.closed) {
        stream.close(http2Constants.NGHTTP2_CANCEL);
      }
    });
    stream.on("response", (reply) => {
      const status = reply[":status"] ?? 502;
      if (status !== 200) {
        refuseUpgrade(socket, status >= 400 && status < 600 ? status : 502);
        stream.close();
        return;
      }
      socket.write(switchingLines(websocketAccept(key), first(reply["sec-websocket-protocol"]), first(reply["sec-websocket-extensions"])));
      if (head.length > 0) {
        stream.write(head);
      }
      spliceStreams(stream, socket);
      onOpen();
    });
  };

  /** Forwards the browser's upgrade to the replica that holds the view, and joins the two sockets. */
  const upgradeThere = async (target: string, socket: Duplex, head: Buffer, headers: HeaderMap, view: NativeView, path: string, key: string, onOpen: () => void): Promise<void> => {
    const { authority } = authorityOf(headers, view.port);
    const { url, signed, send } = sendTo(target, forwardPath(view, authority, path));
    const signature = signReplicaRequest(await deps.secret(), { method: "GET", path: signed, viewId: view.viewId, at: Date.now() });
    const upstream = send(url, {
      method: "GET",
      headers: { ...outgoingOf(headers), connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key, [REPLICA_SIGNATURE_HEADER]: signature },
    });
    upstream.on("upgrade", (reply, tunnel, tunnelHead) => {
      tunnel.on("error", () => undefined);
      const accept = first(reply.headers["sec-websocket-accept"]);
      if (accept === undefined || socket.destroyed) {
        tunnel.destroy();
        refuseUpgrade(socket, 502);
        return;
      }
      socket.write(switchingLines(accept, first(reply.headers["sec-websocket-protocol"]), first(reply.headers["sec-websocket-extensions"])));
      if (tunnelHead.length > 0) {
        socket.write(tunnelHead);
      }
      if (head.length > 0) {
        tunnel.write(head);
      }
      spliceStreams(tunnel, socket);
      onOpen();
    });
    upstream.on("response", (reply) => {
      reply.resume();
      refuseUpgrade(socket, reply.headers[REPLICA_REFUSED_HEADER] !== undefined ? 503 : (reply.statusCode ?? 502));
    });
    upstream.on("error", () => {
      logger.warn("preview.native-forward-failed", { viewId: view.viewId, upgrade: true });
      refuseUpgrade(socket, 502);
    });
    upstream.end();
  };

  const takeUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    const host = (request.headers.host ?? "").toLowerCase();
    const path = pathOf(request);
    if (new URL(path, "http://preview.invalid").pathname === PREVIEW_CHECK_PATH) {
      answerCheckUpgrade(request, socket);
      return;
    }
    const key = parsePreviewHost(host, domain);
    if (key === null) {
      refuseUpgrade(socket, 404);
      return;
    }
    const got = await ready(request, host, key);
    if (!got.ok) {
      refuseUpgrade(socket, got.status);
      return;
    }
    const rewritten = rewriteRequest(headerMapOf(request.headers), { port: got.view.port, previewHost: host, hostRewrite: got.view.hostRewrite, outsideLink: got.view.outsideLink, scheme: origin.scheme });
    const wsKey = first(request.headers["sec-websocket-key"]);
    if (!rewritten.ok) {
      logger.info("preview.native-upgrade-refused", { viewId: got.view.viewId, reason: rewritten.reason });
      refuseUpgrade(socket, 403);
      return;
    }
    if (wsKey === undefined) {
      refuseUpgrade(socket, 400);
      return;
    }
    const grant = got.grant;
    const viewId = got.view.viewId;
    const onOpen = (): void => {
      grant.sockets.set(socket, viewId);
      grant.lastUse = Date.now();
      socket.on("close", () => {
        grant.sockets.delete(socket);
        grant.lastUse = Date.now();
      });
    };
    if (got.where.at === "here") {
      upgradeOn(got.where.session, socket, head, rewritten.headers, got.view.port, path, wsKey, onOpen);
      return;
    }
    await upgradeThere(got.where.url, socket, head, rewritten.headers, got.view, path, wsKey, onOpen);
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => undefined);
    takeUpgrade(request, socket, head).catch((error: unknown) => {
      logger.error("preview.native-upgrade-failed", { error: error instanceof Error ? error.name : "unknown" });
      refuseUpgrade(socket, 502);
    });
  };

  // ---------- another replica's forwarded request, served from this replica's session ----------

  const forwardPattern = /^\/replica\/v1\/native\/([^/]{1,64})\/(\d{4,5})\/([A-Za-z0-9_-]{1,700})(\/.*)$/;

  /** The forwarded request's view, port, `:authority` and path, when its signature verifies. */
  const forwardedOf = async (request: IncomingMessage, method: string): Promise<{ readonly viewId: PreviewViewId; readonly port: number; readonly authority: string; readonly path: string } | "not-ours" | "refused"> => {
    const raw = request.url ?? "/";
    if (!raw.startsWith(NATIVE_FORWARD_PREFIX)) {
      return "not-ours";
    }
    const found = forwardPattern.exec(raw);
    const viewId = found === null ? null : previewViewIdSchema.safeParse(decodeURIComponent(found[1] ?? ""));
    const signature = request.headers[REPLICA_SIGNATURE_HEADER];
    if (found === null || viewId?.success !== true || typeof signature !== "string" || !verifyReplicaRequest(await deps.secret(), { method, path: raw, viewId: viewId.data }, signature, Date.now())) {
      logger.warn("preview.forward-refused", { route: "native" });
      return "refused";
    }
    return { viewId: viewId.data, port: Number(found[2]), authority: Buffer.from(found[3] ?? "", "base64url").toString("utf8"), path: found[4] ?? "/" };
  };

  const handleForwarded = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const method = request.method ?? "GET";
    const forwarded = await forwardedOf(request, method);
    if (forwarded === "not-ours") {
      return false;
    }
    if (forwarded === "refused") {
      response.writeHead(403, { "content-type": "application/json", [REPLICA_REFUSED_HEADER]: "forbidden" });
      response.end(JSON.stringify({ error: { code: "forbidden", message: "a forwarded request whose signature doesn't verify" } }));
      return true;
    }
    const session = deps.tunnels.session(forwarded.viewId);
    if (session === null) {
      // A signed request is never forwarded again: the replica that sent it reads the presence again.
      response.writeHead(409, { "content-type": "application/json", [REPLICA_REFUSED_HEADER]: "not-connected" });
      response.end(JSON.stringify({ error: { code: "not-connected", message: "this replica doesn't hold the view's box connection" } }));
      return true;
    }
    const headers = headerMapOf(request.headers);
    const portHeader = forwarded.authority !== previewTunnel.authority(forwarded.port);
    await new Promise<void>((resolve) => {
      let stream: ClientHttp2Stream;
      try {
        stream = session.request({
          ...outgoingOf(headers, [REPLICA_SIGNATURE_HEADER]),
          ...(portHeader ? { [previewTunnel.portHeader]: String(forwarded.port) } : {}),
          ":method": method,
          ":path": forwarded.path,
          ":scheme": "http",
          ":authority": forwarded.authority,
        });
      } catch {
        response.writeHead(502, { [REPLICA_REFUSED_HEADER]: "failed" });
        response.end();
        resolve();
        return;
      }
      stream.on("error", () => {
        if (response.headersSent) {
          response.destroy();
        } else {
          response.writeHead(502, { [REPLICA_REFUSED_HEADER]: "failed" });
          response.end();
        }
        resolve();
      });
      stream.on("response", (reply) => {
        response.writeHead(reply[":status"] ?? 502, outgoingOf(answerMapOf(reply)));
        stream.pipe(response);
      });
      stream.on("close", resolve);
      response.on("close", () => {
        if (!stream.closed) {
          stream.close(http2Constants.NGHTTP2_CANCEL);
        }
        resolve();
      });
      request.pipe(stream);
    });
    return true;
  };

  const handleForwardedUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (!(request.url ?? "/").startsWith(NATIVE_FORWARD_PREFIX)) {
      return false;
    }
    socket.on("error", () => undefined);
    forwardedOf(request, "GET")
      .then((forwarded) => {
        const wsKey = first(request.headers["sec-websocket-key"]);
        if (forwarded === "not-ours" || forwarded === "refused" || wsKey === undefined) {
          refuseUpgrade(socket, 403);
          return;
        }
        const session = deps.tunnels.session(forwarded.viewId);
        if (session === null) {
          socket.end(`HTTP/1.1 409 Conflict\r\n${REPLICA_REFUSED_HEADER}: not-connected\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
          return;
        }
        upgradeOn(session, socket, head, { ...headerMapOf(request.headers), host: forwarded.authority }, forwarded.port, forwarded.path, wsKey, () => undefined);
      })
      .catch(() => {
        refuseUpgrade(socket, 502);
      });
    return true;
  };

  // ---------- warm while used, and the 5-minute check ----------

  const tick = async (): Promise<void> => {
    const now = Date.now();
    const used = new Map<PreviewViewId, Grant[]>();
    for (const grant of grants.values()) {
      const inUse = grant.active > 0 || grant.sockets.size > 0 || now - grant.lastUse < heartbeatMs;
      if (!inUse && now - grant.lastUse > 15 * 60_000) {
        grants.delete(grant.id);
        continue;
      }
      if (grant.view !== null && inUse) {
        used.set(grant.view.viewId, [...(used.get(grant.view.viewId) ?? []), grant]);
      }
      if (grant.sockets.size > 0 && now - grant.checkedAt >= recheckMs) {
        await check(grant);
      }
    }
    for (const [viewId, holders] of used) {
      const beat = await heartbeatView(viewDeps, { viewId });
      if (!beat.ok) {
        for (const grant of holders) {
          if (grant.view?.viewId === viewId) {
            grant.view = null;
            endSockets(grant, viewId);
          }
        }
      }
    }
  };

  return {
    takes: (host) => isPreviewDomainHost(host, domain),
    handleRequest,
    handleUpgrade,
    handleForwarded: (request, response, url) => (url.pathname.startsWith(NATIVE_FORWARD_PREFIX) ? handleForwarded(request, response) : Promise.resolve(false)),
    handleForwardedUpgrade,
    grants: () => [...grants.values()].map((grant) => ({ grantId: grant.id, checks: grant.checks, viewId: grant.view?.viewId ?? null, sockets: grant.sockets.size })),
    start: () => {
      ticker = setInterval(() => {
        tick().catch((error: unknown) => {
          logger.warn("preview.native-tick-failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      }, Math.min(heartbeatMs, recheckMs));
      ticker.unref();
    },
    stop: () => {
      clearInterval(ticker);
      for (const grant of grants.values()) {
        endSockets(grant, null);
      }
      grants.clear();
    },
  };
};
