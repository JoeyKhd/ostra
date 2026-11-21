import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  checkViewInput,
  closedViewIds,
  createPanelPreviewTokens,
  enqueueViewInput,
  markViewConnected,
  markViewDisconnected,
  parsePanelPreviewPath,
  previewViewInTx,
  REPLICA_SIGNATURE_HEADER,
  signReplicaRequest,
  verifyReplicaRequest,
} from "@ostra/domain";
import type { ChangeNotices, Clock, CommandOutbox, PanelPreviewClaims, PanelPreviewTokens, PreviewViewRow } from "@ostra/domain";
import {
  PREVIEW_FRAMES_BODY_PART,
  panelPreviewInputBodySchema,
  parseJson,
  previewConnectionQuerySchema,
  previewFramesBodySchema,
  previewMessageMaxBytes,
  previewPaths,
  previewSubprotocols,
  previewTunnel,
  previewViewIdSchema,
  runnerLimits,
} from "@ostra/protocol";
import type { LeaseEpoch, PreviewFramesResponse, PreviewViewId } from "@ostra/protocol";
import { WebSocketServer } from "ws";

import { bearerToken } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { checkTaskLease, isTaskToken } from "../gateway/task-token.ts";
import type { TaskTokenClaims, TaskTokens } from "../gateway/task-token.ts";
import { readBody, sendJson } from "../http.ts";
import type { RouteHandler } from "../server.ts";
import { createCliTunnels } from "./cli-tunnel.ts";
import type { CliTunnels } from "./cli-tunnel.ts";
import { createPreviewHub } from "./hub.ts";
import { parseMultipart } from "./multipart.ts";
import type { PreviewHub } from "./hub.ts";
import { createNativePreviews } from "./native.ts";
import type { NativePreviews } from "./native.ts";
import { createTunnelHub } from "./tunnels.ts";
import type { TunnelHub } from "./tunnels.ts";

// Previews on core (milestone 8, ticket 19, F-141, F-142, ADR 0068 "The preview connection"):
//
// - the box's preview connection, `GET /runner/v1/preview?view=&leaseEpoch=` upgraded to a binary
//   WebSocket, with the box's task token (on `host`, the runner's access token) and the lease
//   epoch: a stale epoch is refused as an event is. The replica that takes it writes the view's
//   presence (its `OSTRA_CORE_REPLICA_URL`) and relays its frames;
// - the HTTP carrier's frames, `POST /runner/v1/preview/frames`, at most 2 a second a view (Q306);
// - the panel's stream and input of one view, `/panel/v1/previews/:viewId/stream|input`, with the
//   panel's token for that view (the web app relays them, ADR 0035). A replica that gets one for a
//   view another replica holds forwards it there, signed under the secrets key every replica
//   shares, and a replica refuses a forwarded request it can't verify. One replica never forwards.
//
// - a view in a tunnel mode (`cli`, `native`; ticket 23): the box's connection carries one HTTP/2
//   connection with core as the client (`tunnels.ts`), and `ostra preview`'s endpoint,
//   `GET /cli/v1/tunnel?ticket=…`, serves the CLI's (`cli-tunnel.ts`).
//
// Never logged: a token, a signature, a frame, typed text or a path. Logged: IDs and reasons.

export type PreviewsDeps = {
  readonly db: Db;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The runner access tokens (a `host` runner's preview connection) and the boxes' task tokens. */
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  /** The secrets key's text, read when first needed: the panel's tokens and the replicas' signatures. */
  readonly secret: () => Promise<string>;
  /** This replica's internal address (`OSTRA_CORE_REPLICA_URL`), once core listens. */
  readonly replicaUrl: () => string;
  /** How long a viewer's stream waits for the box's connection to reach a replica *(working value)*. */
  readonly presenceWaitMs?: number;
  /** How often the views held here are checked against their rows. */
  readonly checkMs?: number;
  /**
   * The warm cap a new tunnel view is refused past (`OSTRA_PREVIEW_WARM_MINUTES`), and the preview
   * domain (`OSTRA_PREVIEW_DOMAIN`): set, the native preview's proxy is built (ticket 25).
   */
  readonly settings: { readonly warmMinutes: number; readonly domain?: string | null };
  /** The panel's and core's public addresses, which the native preview's frames and hosts follow. */
  readonly urls?: { readonly publicUrl: string; readonly corePublicUrl: string };
  /** The native preview's heartbeat and check intervals (30 s and 5 minutes; tests shorten them). */
  readonly nativeHeartbeatMs?: number;
  readonly nativeRecheckMs?: number;
  /** How often a CLI's tunnel checks its CLI session again (5 minutes; tests shorten it). */
  readonly cliRecheckMs?: number;
  /** How often a CLI's tunnel heartbeats its view (30 s; tests shorten it). */
  readonly cliHeartbeatMs?: number;
  /** How long a CLI gets to answer core's close frame before its socket is cut (30 s; tests shorten it). */
  readonly cliCloseWaitMs?: number;
};

export type Previews = {
  readonly handleRequest: RouteHandler;
  /** Takes an upgrade of the preview connection's path; `false` for any other path. */
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  readonly hub: PreviewHub;
  /** The tunnel views' HTTP/2 sessions to their boxes: the native preview's proxy (ticket 25) sends on `tunnels.session(viewId)`. */
  readonly tunnels: TunnelHub;
  readonly cliTunnels: CliTunnels;
  /** The native preview's proxy (ticket 25), only with a preview domain: core's server hands it the preview hosts. */
  readonly native: NativePreviews | null;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
};

/** What the panel's routes answer when they refuse: a code the web app words, never task content. */
type PanelErrorCode = "unauthorized" | "forbidden" | "not-found" | "view-closed" | "not-connected" | "watch-only" | "bad-request" | "forwarding-failed";

const panelError = (response: ServerResponse, status: number, code: PanelErrorCode, message: string): void => {
  sendJson(response, status, { error: { code, message } });
};

const rejectUpgrade = (socket: Duplex, status: 400 | 401 | 404 | 409 | 500, code: string, message: string, currentEpoch?: number): void => {
  const body = JSON.stringify({ error: { code, message, ...(currentEpoch === undefined ? {} : { currentEpoch }) } });
  const reason = { 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error" }[status];
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`);
};

/** Who the box's connection or frames came from: the box (its task token) or the runner (`host`). */
type BoxCaller = { readonly kind: "task"; readonly claims: TaskTokenClaims } | { readonly kind: "runner"; readonly runnerId: string; readonly organizationId: string };

type LeaseCheck = { readonly ok: true } | { readonly ok: false; readonly code: "stale-lease"; readonly currentEpoch: number } | { readonly ok: false; readonly code: "unauthorized" };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** The same viewer: the panel's token names the member or the link the view was opened for. */
const sameViewer = (claims: PanelPreviewClaims, view: PreviewViewRow): boolean =>
  claims.organizationId === view.organizationId &&
  (claims.viewer.kind === "member"
    ? view.viewer.kind === "member" && view.viewer.memberId === claims.viewer.memberId
    : view.viewer.kind === "link" && view.viewer.linkId === claims.viewer.linkId);

export const createPreviews = (deps: PreviewsDeps): Previews => {
  const logger = deps.logger.child({ component: "previews" });
  const hub = createPreviewHub(logger);
  const now = (): number => deps.clock.now();
  const presenceWaitMs = deps.presenceWaitMs ?? 10_000;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: previewMessageMaxBytes,
    handleProtocols: (protocols) => (protocols.has(previewSubprotocols.stream) ? previewSubprotocols.stream : false),
  });
  const tunnelWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: previewTunnel.messageMaxBytes,
    handleProtocols: (protocols) => (protocols.has(previewSubprotocols.tunnel) ? previewSubprotocols.tunnel : false),
  });
  const tunnels = createTunnelHub(logger);
  const cliTunnels = createCliTunnels({
    db: deps.db,
    outbox: deps.outbox,
    notices: deps.notices,
    clock: deps.clock,
    logger,
    settings: deps.settings,
    tunnels,
    secret: deps.secret,
    replicaUrl: deps.replicaUrl,
    presenceWaitMs,
    ...(deps.cliRecheckMs === undefined ? {} : { recheckMs: deps.cliRecheckMs }),
    ...(deps.cliHeartbeatMs === undefined ? {} : { heartbeatMs: deps.cliHeartbeatMs }),
    ...(deps.cliCloseWaitMs === undefined ? {} : { closeWaitMs: deps.cliCloseWaitMs }),
  });
  const domain = deps.settings.domain ?? null;
  const native =
    domain === null
      ? null
      : createNativePreviews({
          db: deps.db,
          outbox: deps.outbox,
          notices: deps.notices,
          clock: deps.clock,
          logger,
          settings: { domain, publicUrl: deps.urls?.publicUrl ?? "http://localhost:3000", corePublicUrl: deps.urls?.corePublicUrl ?? "http://localhost:8787", warmMinutes: deps.settings.warmMinutes },
          tunnels,
          secret: deps.secret,
          replicaUrl: deps.replicaUrl,
          presenceWaitMs,
          ...(deps.nativeHeartbeatMs === undefined ? {} : { heartbeatMs: deps.nativeHeartbeatMs }),
          ...(deps.nativeRecheckMs === undefined ? {} : { recheckMs: deps.nativeRecheckMs }),
        });
  let panelTokens: Promise<PanelPreviewTokens> | undefined;
  const tokensOnce = (): Promise<PanelPreviewTokens> => (panelTokens ??= deps.secret().then(createPanelPreviewTokens));
  /** The frames each view took over the HTTP carrier in the last second, on this replica. */
  const httpFrameTimes = new Map<PreviewViewId, number[]>();
  let checkTimer: ReturnType<typeof setInterval> | undefined;

  // ---------- the box's side ----------

  const boxCaller = (authorization: string | undefined): BoxCaller | null => {
    const token = bearerToken(authorization);
    if (token === null) {
      return null;
    }
    if (isTaskToken(token)) {
      const claims = deps.taskTokens.verify(token);
      return claims === null ? null : { kind: "task", claims };
    }
    const claims = deps.tokens.verify(token, now());
    return claims === null ? null : { kind: "runner", runnerId: claims.runnerId, organizationId: claims.organizationId };
  };

  /** The caller holds the view's lease at `leaseEpoch`, and it's still the task's: else stale, as an event would be. */
  const checkBoxLease = async (caller: BoxCaller, view: PreviewViewRow, leaseEpoch: LeaseEpoch): Promise<LeaseCheck> => {
    const task = await deps.db.task.findFirst({ where: { id: view.taskId, organizationId: view.organizationId }, select: { leaseEpoch: true } });
    if (task === null) {
      return { ok: false, code: "unauthorized" };
    }
    switch (caller.kind) {
      case "task": {
        if (caller.claims.taskId !== view.taskId || caller.claims.organizationId !== view.organizationId) {
          return { ok: false, code: "unauthorized" };
        }
        if (caller.claims.leaseEpoch !== leaseEpoch) {
          return { ok: false, code: "stale-lease", currentEpoch: task.leaseEpoch };
        }
        const lease = await checkTaskLease(deps.db, caller.claims);
        if (!lease.ok) {
          return lease.error === "stale-lease" ? { ok: false, code: "stale-lease", currentEpoch: lease.currentEpoch } : { ok: false, code: "unauthorized" };
        }
        break;
      }
      case "runner": {
        if (caller.organizationId !== view.organizationId) {
          return { ok: false, code: "unauthorized" };
        }
        const lease = await deps.db.lease.findFirst({ where: { taskId: view.taskId, epoch: leaseEpoch, organizationId: view.organizationId }, select: { runnerId: true, state: true } });
        if (lease === null) {
          return { ok: false, code: "stale-lease", currentEpoch: task.leaseEpoch };
        }
        if (lease.runnerId !== caller.runnerId) {
          return { ok: false, code: "unauthorized" };
        }
        if (lease.state !== "active") {
          return { ok: false, code: "stale-lease", currentEpoch: task.leaseEpoch };
        }
        break;
      }
      default:
        return caller satisfies never;
    }
    if (task.leaseEpoch !== leaseEpoch || view.leaseEpoch !== leaseEpoch) {
      return { ok: false, code: "stale-lease", currentEpoch: task.leaseEpoch };
    }
    return { ok: true };
  };

  const takeUpgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> => {
    // The box's connection is the sidecar's or the `host` runner's, never a browser page's: a page's
    // upgrade names its `Origin`, such as a preview host's (ADR 0068, the panel's own defences).
    if (request.headers.origin !== undefined) {
      rejectUpgrade(socket, 400, "bad-request", "a browser's page never opens the box's preview connection");
      return;
    }
    const query = previewConnectionQuerySchema.safeParse({ view: url.searchParams.get("view"), leaseEpoch: url.searchParams.get("leaseEpoch") });
    if (!query.success) {
      rejectUpgrade(socket, 400, "bad-request", "the query names a view and its lease epoch");
      return;
    }
    const caller = boxCaller(request.headers.authorization);
    if (caller === null) {
      rejectUpgrade(socket, 401, "unauthorized", "the box's task token, or a host runner's access token, is required");
      return;
    }
    const viewId = query.data.view;
    const view = await previewViewInTx(deps.db, viewId);
    if (view === null || view.lifecycle.state === "closed") {
      rejectUpgrade(socket, 404, "not-found", "no such open view");
      return;
    }
    const lease = await checkBoxLease(caller, view, query.data.leaseEpoch);
    if (!lease.ok) {
      logger.info("preview.connection-refused", { viewId, code: lease.code });
      if (lease.code === "stale-lease") {
        rejectUpgrade(socket, 409, "stale-lease", "this lease epoch is behind the task's", lease.currentEpoch);
      } else {
        rejectUpgrade(socket, 401, "unauthorized", "this token doesn't hold the view's lease");
      }
      return;
    }
    const offered = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    // `stream` for the browser view; every other mode (`cli`, `native`) is a tunnel (ADR 0068).
    const tunnel = view.mode !== "stream";
    const protocol = tunnel ? previewSubprotocols.tunnel : previewSubprotocols.stream;
    if (!offered.includes(protocol)) {
      rejectUpgrade(socket, 400, "bad-request", `this view's subprotocol is ${protocol}`);
      return;
    }
    (tunnel ? tunnelWss : wss).handleUpgrade(request, socket, head, (ws) => {
      const me = deps.replicaUrl();
      const attach = tunnel ? tunnels.attachBox : hub.attachSocket;
      attach(viewId, ws, () => {
        markViewDisconnected(deps.db, viewId, me).catch((error: unknown) => {
          logger.warn("preview.presence-clear-failed", { viewId, error: error instanceof Error ? error.name : "unknown" });
        });
      });
      markViewConnected(deps.db, viewId, me, now())
        .then((row) => {
          if (row === null) {
            if (tunnel) {
              tunnels.close(viewId, "view-closed");
            } else {
              hub.close(viewId, "closed");
            }
            return;
          }
          logger.info("preview.connected", { viewId, taskId: view.taskId, leaseEpoch: query.data.leaseEpoch, mode: view.mode });
        })
        .catch((error: unknown) => {
          logger.warn("preview.presence-failed", { viewId, error: error instanceof Error ? error.name : "unknown" });
          if (tunnel) {
            tunnels.close(viewId, "box-gone");
          } else {
            hub.close(viewId, "box-stopping");
          }
        });
    });
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    if (cliTunnels.handleUpgrade(request, socket, head)) {
      return true;
    }
    if (native?.handleForwardedUpgrade(request, socket, head) === true) {
      return true;
    }
    const url = new URL(request.url ?? "/", "http://ostra.invalid");
    if (url.pathname !== previewPaths.connection) {
      return false;
    }
    takeUpgrade(request, socket, head, url).catch((error: unknown) => {
      logger.error("preview.upgrade-failed", { error: error instanceof Error ? error.name : "unknown" });
      rejectUpgrade(socket, 500, "internal", "internal error");
    });
    return true;
  };

  // ---------- forwarding to the replica that holds a view ----------

  /**
   * Sends the request on to `target`, the replica in the view's presence, signed (Q305), and
   * relays its answer as it streams. A signed request is never forwarded again.
   */
  const forward = async (
    target: string,
    method: "GET" | "POST",
    pathAndQuery: string,
    viewId: PreviewViewId,
    body: { readonly bytes: Buffer; readonly contentType: string } | null,
    response: ServerResponse,
  ): Promise<void> => {
    const signature = signReplicaRequest(await deps.secret(), { method, path: pathAndQuery, viewId, at: now() });
    const url = new URL(pathAndQuery, target);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    await new Promise<void>((resolve) => {
      const upstream = send(
        url,
        {
          method,
          headers: {
            [REPLICA_SIGNATURE_HEADER]: signature,
            ...(body === null ? {} : { "content-type": body.contentType, "content-length": String(body.bytes.length) }),
          },
        },
        (answer) => {
          const headers: Record<string, string> = { "cache-control": "no-store" };
          const type = answer.headers["content-type"];
          if (type !== undefined) {
            headers["content-type"] = type;
          }
          if (method === "GET") {
            headers["x-accel-buffering"] = "no";
          }
          response.writeHead(answer.statusCode ?? 502, headers);
          response.flushHeaders();
          answer.pipe(response);
          answer.on("end", resolve);
          answer.on("error", () => {
            response.destroy();
            resolve();
          });
        },
      );
      upstream.on("error", () => {
        logger.warn("preview.forward-failed", { viewId });
        if (response.headersSent) {
          response.destroy();
        } else {
          panelError(response, 502, "forwarding-failed", "the replica that holds this view didn't answer");
        }
        resolve();
      });
      response.on("close", () => {
        upstream.destroy();
        resolve();
      });
      upstream.end(body?.bytes);
    });
  };

  /** A request's own signature, when another replica forwarded it: verified, or refused. */
  const forwardedBy = async (request: IncomingMessage, url: URL, viewId: PreviewViewId, method: string): Promise<"none" | "verified" | "refused"> => {
    const signature = request.headers[REPLICA_SIGNATURE_HEADER];
    if (signature === undefined) {
      return "none";
    }
    const good = typeof signature === "string" && verifyReplicaRequest(await deps.secret(), { method, path: `${url.pathname}${url.search}`, viewId }, signature, now());
    return good ? "verified" : "refused";
  };

  // ---------- the panel's side ----------

  type PanelCaller = { readonly forwarded: true } | { readonly forwarded: false; readonly claims: PanelPreviewClaims };

  /** The panel's token for this view, or another replica's signature. */
  const panelCaller = async (request: IncomingMessage, response: ServerResponse, url: URL, viewId: PreviewViewId, method: "GET" | "POST"): Promise<PanelCaller | null> => {
    const forwarded = await forwardedBy(request, url, viewId, method);
    if (forwarded === "refused") {
      logger.warn("preview.forward-refused", { viewId });
      panelError(response, 403, "forbidden", "a forwarded request whose signature doesn't verify");
      return null;
    }
    if (forwarded === "verified") {
      return { forwarded: true };
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : (await tokensOnce()).verify(token, now(), viewId);
    if (claims === null) {
      panelError(response, 401, "unauthorized", "the panel's token for this view is required");
      return null;
    }
    return { forwarded: false, claims };
  };

  /** The view, open, for this caller; or the refusal sent. */
  const openViewFor = async (response: ServerResponse, caller: PanelCaller, viewId: PreviewViewId): Promise<PreviewViewRow | null> => {
    const view = await previewViewInTx(deps.db, viewId);
    if (view === null) {
      panelError(response, 404, "not-found", "no such view");
      return null;
    }
    if (!caller.forwarded && !sameViewer(caller.claims, view)) {
      panelError(response, 403, "forbidden", "this token is for another viewer");
      return null;
    }
    if (view.lifecycle.state === "closed") {
      panelError(response, 410, "view-closed", "this view is closed");
      return null;
    }
    return view;
  };

  const handleStream = async (request: IncomingMessage, response: ServerResponse, url: URL, viewId: PreviewViewId): Promise<void> => {
    const caller = await panelCaller(request, response, url, viewId, "GET");
    if (caller === null || (await openViewFor(response, caller, viewId)) === null) {
      return;
    }
    // Where the box's connection is: here, another replica (forward), or not yet anywhere (wait).
    const deadline = Date.now() + presenceWaitMs;
    for (;;) {
      if (response.destroyed) {
        return;
      }
      if (hub.attachStream(viewId, response)) {
        logger.info("preview.stream-open", { viewId, forwarded: caller.forwarded, streams: hub.streams(viewId) });
        return;
      }
      const view = await previewViewInTx(deps.db, viewId);
      if (view === null || view.lifecycle.state === "closed") {
        panelError(response, 410, "view-closed", "this view is closed");
        return;
      }
      const me = deps.replicaUrl();
      if (!caller.forwarded && view.replicaUrl !== null && view.replicaUrl !== me) {
        logger.info("preview.stream-forwarded", { viewId });
        await forward(view.replicaUrl, "GET", `${url.pathname}${url.search}`, viewId, null, response);
        return;
      }
      if (Date.now() >= deadline) {
        panelError(response, 409, "not-connected", "the box's preview connection hasn't reached the server yet");
        return;
      }
      await sleep(100);
    }
  };

  const handleInput = async (request: IncomingMessage, response: ServerResponse, url: URL, viewId: PreviewViewId): Promise<void> => {
    const caller = await panelCaller(request, response, url, viewId, "POST");
    if (caller === null) {
      return;
    }
    const raw = await readBody(request, runnerLimits.previewJsonMaxBytes);
    if (raw === "too-large" || raw === "timeout") {
      panelError(response, 400, "bad-request", "the input batch is too large, or didn't arrive");
      return;
    }
    const json = parseJson(raw.toString("utf8"));
    const body = json.ok ? panelPreviewInputBodySchema.safeParse(json.value) : null;
    if (body?.success !== true) {
      panelError(response, 400, "bad-request", "the body is a batch of input events");
      return;
    }
    if ((await openViewFor(response, caller, viewId)) === null) {
      return;
    }
    // The access is read again for every batch: a watch-only viewer's input stops here (Q301).
    const check = await checkViewInput(deps.db, viewId, now());
    if (!check.ok) {
      switch (check.reason) {
        case "not-found":
          panelError(response, 404, "not-found", "no such view");
          return;
        case "closed":
          panelError(response, 410, "view-closed", "this view is closed");
          return;
        case "watch-only":
          logger.info("preview.input-dropped", { viewId, reason: "watch-only", events: body.data.events.length });
          panelError(response, 403, "watch-only", "this view is watch-only");
          return;
        case "not-allowed":
        case "link-expired":
        case "link-revoked":
        case "public-links-off":
        case "link-unknown":
        case "level-unknown":
          logger.info("preview.input-dropped", { viewId, reason: check.reason, events: body.data.events.length });
          panelError(response, 403, "forbidden", "this viewer may no longer give input");
          return;
        default:
          check.reason satisfies never;
          return;
      }
    }
    if (hub.sendInput(viewId, body.data.events)) {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    const me = deps.replicaUrl();
    if (!caller.forwarded && check.view.replicaUrl !== null && check.view.replicaUrl !== me && !hub.holds(viewId)) {
      await forward(check.view.replicaUrl, "POST", `${url.pathname}${url.search}`, viewId, { bytes: raw, contentType: "application/json" }, response);
      return;
    }
    // The HTTP carrier: down the long poll as `preview.input` (Q306).
    if (check.box !== null && (await enqueueViewInput(deps, check.view, check.box, body.data.events))) {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    panelError(response, 409, "not-connected", "the box's preview connection hasn't reached the server");
  };

  // ---------- the HTTP carrier's frames (Q306) ----------

  const framesAnswer = (response: ServerResponse, status: number, body: PreviewFramesResponse): void => {
    sendJson(response, status, body);
  };

  /** At most `httpCarrierFramesPerSecond` frames a second for a view, on this replica. */
  const tooFast = (viewId: PreviewViewId, count: number): boolean => {
    const at = now();
    const recent = (httpFrameTimes.get(viewId) ?? []).filter((time) => at - time < 1_000);
    if (recent.length + count > runnerLimits.httpCarrierFramesPerSecond) {
      httpFrameTimes.set(viewId, recent);
      return true;
    }
    httpFrameTimes.set(viewId, [...recent, ...Array.from({ length: count }, () => at)]);
    return false;
  };

  const handleFrames = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const caller = boxCaller(request.headers.authorization);
    const signed = request.headers[REPLICA_SIGNATURE_HEADER] !== undefined;
    if (caller === null && !signed) {
      sendJson(response, 401, { error: { code: "unauthorized", message: "the box's task token, or a host runner's access token, is required" } });
      return;
    }
    const cap = runnerLimits.httpCarrierFramesPerSecond * (runnerLimits.previewFrameMaxBytes + 4_096) + runnerLimits.previewJsonMaxBytes;
    const raw = await readBody(request, cap);
    if (raw === "too-large" || raw === "timeout") {
      framesAnswer(response, 413, { code: "invalid" });
      return;
    }
    const contentType = request.headers["content-type"] ?? "";
    const form = parseMultipart(raw, contentType, runnerLimits.httpCarrierFramesPerSecond + 1);
    const part = form?.get(PREVIEW_FRAMES_BODY_PART);
    const json = part === undefined ? null : parseJson(part.toString("utf8"));
    const body = json?.ok === true ? previewFramesBodySchema.safeParse(json.value) : null;
    if (form === null || body?.success !== true) {
      framesAnswer(response, 400, { code: "invalid" });
      return;
    }
    const viewId = body.data.viewId;
    if (signed) {
      // Another replica took the frames and forwards them to the one that holds the view.
      if ((await forwardedBy(request, url, viewId, "POST")) !== "verified") {
        logger.warn("preview.forward-refused", { viewId });
        sendJson(response, 403, { error: { code: "unauthorized", message: "a forwarded request whose signature doesn't verify" } });
        return;
      }
    }
    const view = await previewViewInTx(deps.db, viewId);
    if (view === null || view.lifecycle.state === "closed") {
      framesAnswer(response, 410, { code: "view-closed" });
      return;
    }
    if (caller !== null) {
      const lease = await checkBoxLease(caller, view, body.data.leaseEpoch);
      if (!lease.ok) {
        framesAnswer(response, lease.code === "stale-lease" ? 409 : 401, { code: lease.code === "stale-lease" ? "stale-lease" : "invalid" });
        return;
      }
    }
    const frames: { readonly header: { readonly seq: number; readonly at: number; readonly width: number; readonly height: number }; readonly jpeg: Uint8Array }[] = [];
    for (const frame of body.data.frames) {
      const bytes = form.get(frame.part);
      const jpeg = bytes === undefined ? null : new Uint8Array(bytes);
      if (jpeg === null || jpeg.length === 0 || jpeg.length > runnerLimits.previewFrameMaxBytes || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
        framesAnswer(response, 400, { code: "invalid" });
        return;
      }
      frames.push({ header: { seq: frame.seq, at: frame.at, width: frame.width, height: frame.height }, jpeg });
    }
    const me = deps.replicaUrl();
    if (!signed && view.replicaUrl !== null && view.replicaUrl !== me && !hub.holds(viewId)) {
      await forward(view.replicaUrl, "POST", `${url.pathname}${url.search}`, viewId, { bytes: raw, contentType }, response);
      return;
    }
    if (tooFast(viewId, frames.length)) {
      framesAnswer(response, 429, { code: "too-fast" });
      return;
    }
    if (!hub.holds(viewId)) {
      hub.holdHttp(viewId);
      await markViewConnected(deps.db, viewId, me, now());
    }
    for (const frame of frames) {
      await hub.relayHttpFrame(viewId, frame.header, frame.jpeg);
    }
    const ackedUpTo = Math.max(...frames.map((frame) => frame.header.seq));
    framesAnswer(response, 200, { ackedUpTo });
  };

  // ---------- the views held here, against their rows ----------

  /** Ends the views held here that closed, or whose lease moved on, and the CLIs here whose view closed. */
  const checkHeld = async (): Promise<void> => {
    await cliTunnels.check();
    const streamed = new Set(hub.held());
    const held = [...streamed, ...tunnels.held()];
    if (held.length === 0) {
      return;
    }
    const end = (viewId: PreviewViewId, reason: "closed" | "stale-lease"): void => {
      logger.info("preview.view-ended", { viewId, reason });
      if (streamed.has(viewId)) {
        hub.close(viewId, reason);
      } else {
        tunnels.close(viewId, reason === "closed" ? "view-closed" : "box-gone");
      }
    };
    for (const viewId of await closedViewIds(deps.db, held)) {
      end(viewId, "closed");
    }
    const rows = await deps.db.previewView.findMany({ where: { id: { in: held }, state: { not: "closed" } }, select: { id: true, leaseEpoch: true, task: { select: { leaseEpoch: true } } } });
    for (const row of rows) {
      if (row.task.leaseEpoch !== row.leaseEpoch) {
        end(previewViewIdSchema.parse(row.id), "stale-lease");
      }
    }
  };

  const handleRequest: RouteHandler = async (request, response, url) => {
    if (native !== null && (await native.handleForwarded(request, response, url))) {
      return true;
    }
    if (url.pathname === previewPaths.frames) {
      if (request.method !== "POST") {
        sendJson(response, 404, { error: { code: "not-found", message: "no such route" } });
        return true;
      }
      await handleFrames(request, response, url);
      return true;
    }
    const panel = parsePanelPreviewPath(url.pathname);
    if (panel === null) {
      return false;
    }
    if (panel.route === "stream" && request.method === "GET") {
      await handleStream(request, response, url, panel.viewId);
      return true;
    }
    if (panel.route === "input" && request.method === "POST") {
      await handleInput(request, response, url, panel.viewId);
      return true;
    }
    panelError(response, 404, "not-found", "no such route");
    return true;
  };

  return {
    handleRequest,
    handleUpgrade,
    hub,
    tunnels,
    cliTunnels,
    native,
    start: () => {
      native?.start();
      checkTimer = setInterval(() => {
        checkHeld().catch((error: unknown) => {
          logger.warn("preview.check-failed", { error: error instanceof Error ? error.name : "unknown" });
        });
      }, deps.checkMs ?? 2_000);
      checkTimer.unref();
    },
    stop: async () => {
      clearInterval(checkTimer);
      native?.stop();
      hub.stop();
      cliTunnels.stop();
      tunnels.stop();
      await Promise.all(
        [wss, tunnelWss].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => {
                resolve();
              });
            }),
        ),
      );
    },
  };
};
