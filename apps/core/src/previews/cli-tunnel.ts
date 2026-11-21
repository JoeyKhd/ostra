import type { IncomingMessage } from "node:http";
import type { ServerHttp2Session } from "node:http2";
import type { Duplex } from "node:stream";

import { webSocketDuplex } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  checkCliTunnel,
  closeView,
  heartbeatView,
  openCliView,
  PREVIEW_HEARTBEAT_MS,
  previewViewInTx,
  REPLICA_SIGNATURE_HEADER,
  signReplicaRequest,
  verifyReplicaRequest,
} from "@ostra/domain";
import type { ChangeNotices, Clock, CliTunnelView, CommandOutbox } from "@ostra/domain";
import { CLI_TUNNEL_SUBPROTOCOL, CORE_CLI_TUNNEL_PATH, cliTunnelErrorWords, cliTunnelQuerySchema, previewTunnel, previewViewIdSchema } from "@ostra/protocol";
import type { CliTunnelError, CliTunnelErrorCode, PreviewViewId } from "@ostra/protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { z } from "zod";

import { cliTunnelCloseCode, cliTunnelCloseText } from "./tunnels.ts";
import type { CliTunnelEnd, TunnelHub } from "./tunnels.ts";

// Core's tunnel for `ostra preview` (milestone 8, ticket 23, F-143, ADR 0068 "`ostra preview`"):
// `GET /cli/v1/tunnel?ticket=…`, upgraded to a binary WebSocket whose messages are one HTTP/2
// connection with the CLI as the client and core as the server.
//
// - The ticket is redeemed and its view opened in `cli` mode (`openCliView`) before the upgrade,
//   and core waits for the box's preview connection in `tunnel` mode. A refusal is an HTTP answer
//   with the protocol's `cliTunnelErrorSchema` body, never an open socket that does nothing.
// - On the replica that holds the box's connection, core serves the CLI's HTTP/2 itself
//   (`TunnelHub.serveCli`). Another replica opens a WebSocket of its own to that one, signed under
//   the secrets key (`?view=&port=`, ADR 0068's forwarding), and relays the CLI's messages as they
//   are, with the far end's close code; a signed request is never forwarded again.
// - While the tunnel lasts the replica that has the CLI's socket heartbeats the view (the member's
//   tunnel open is watching, as an open pane is) and checks the CLI session every 5 minutes: a
//   revoked or expired session, or a member who can no longer open the task, ends it with 4401.
//   The view closes with the CLI's socket.
// - A CLI is anyone's client, a hostile one included, and never takes core down. Its HTTP/2
//   session runs on its socket through `webSocketDuplex` (never `ws`'s `createWebSocketStream`,
//   whose shutdown hangs once the socket is cut, and the session's next write then throws inside
//   Node, uncaught). The two end together (`shut`): the session is destroyed with the close frame,
//   the socket closes when the session ends (1002 for bytes that aren't HTTP/2 or a frame `ws`
//   refuses), and a CLI that never answers the close frame is cut after `closeWaitMs`.
//
// Never logged: the ticket, a signature, a byte of the tunnel. Logged: IDs, codes and reasons.

export type CliTunnelsDeps = {
  readonly db: Db;
  readonly outbox: CommandOutbox;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: { readonly warmMinutes: number };
  readonly tunnels: TunnelHub;
  /** The secrets key's text: the replicas' signatures. */
  readonly secret: () => Promise<string>;
  /** This replica's internal address (`OSTRA_CORE_REPLICA_URL`). */
  readonly replicaUrl: () => string;
  /** How long the CLI's upgrade waits for the box's preview connection *(working value)*. */
  readonly presenceWaitMs: number;
  /** How often the CLI session is checked again: 5 minutes. */
  readonly recheckMs?: number;
  /** How often the view's heartbeat is written: the pane's 30 s. */
  readonly heartbeatMs?: number;
  /** How long a CLI gets to answer core's close frame before its socket is cut: `ws`'s own 30 s. */
  readonly closeWaitMs?: number;
};

export type CliTunnels = {
  /** Takes an upgrade of `/cli/v1/tunnel`; `false` for any other path. */
  readonly handleUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  /** Ends the CLIs here whose view closed: called with the views' check. */
  readonly check: () => Promise<void>;
  /** The CLIs whose socket is on this replica, for a view (tests and the log). */
  readonly open: (viewId: PreviewViewId) => number;
  readonly stop: () => void;
};

/** The CLI session is checked again this often (ticket 23) *(working value)*. */
export const CLI_TUNNEL_RECHECK_MS = 5 * 60_000;

/** A CLI that hasn't answered core's close frame by then is cut: the 30 s `ws` waits itself. */
export const CLI_TUNNEL_CLOSE_WAIT_MS = 30_000;

/** A WebSocket close for a CLI whose bytes aren't HTTP/2, or a frame `ws` refuses (RFC 6455's protocol error). */
const PROTOCOL_ERROR = { code: 1002, text: "protocol error" } as const;

/** A forwarded tunnel's query: the view and the ticket's port, under the signature. */
const forwardedQuerySchema = z.strictObject({ view: previewViewIdSchema, port: z.coerce.number().int().min(1024).max(65_535) });

const statusOf: Readonly<Record<CliTunnelErrorCode, 400 | 403 | 404 | 409 | 502>> = {
  "bad-request": 400,
  "ticket-refused": 403,
  "not-found": 404,
  "port-not-allowed": 403,
  "runner-cannot-tunnel": 409,
  "no-box": 409,
  "not-connected": 409,
  "forwarding-failed": 502,
};

const reasonPhrase = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 500: "Internal Server Error", 502: "Bad Gateway" } as const;

/** Refuses an upgrade with the protocol's error body, in the CLI's words. */
const refuseUpgrade = (socket: Duplex, code: CliTunnelErrorCode): void => {
  const status = statusOf[code];
  const body = JSON.stringify({ error: { code, message: cliTunnelErrorWords(code) } } satisfies CliTunnelError);
  socket.end(`HTTP/1.1 ${String(status)} ${reasonPhrase[status]}\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`);
};

const offers = (request: IncomingMessage, protocol: string): boolean =>
  (request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes(protocol);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

/** A CLI's socket on this replica, and the HTTP/2 session on it once this replica serves one. */
type CliSocket = { readonly ws: WebSocket; session: ServerHttp2Session | null };

/** A CLI's tunnel whose socket is on this replica. */
type OpenCli = CliSocket & {
  readonly view: CliTunnelView;
  /** Ends the tunnel: the CLI's socket closes with the reason's code, and its session goes with it. */
  readonly end: CliTunnelEnd;
  readonly timers: ReturnType<typeof setInterval>[];
};

/** Relays one WebSocket's messages to another, pausing the source while too many are unsent. */
const relay = (from: WebSocket, to: WebSocket): void => {
  let unsent = 0;
  from.on("message", (data: RawData) => {
    if (to.readyState !== WebSocket.OPEN) {
      return;
    }
    unsent += 1;
    if (unsent > 64) {
      from.pause();
    }
    to.send(data, { binary: true }, () => {
      unsent -= 1;
      if (unsent <= 16 && from.isPaused) {
        from.resume();
      }
    });
  });
};

export const createCliTunnels = (deps: CliTunnelsDeps): CliTunnels => {
  const logger = deps.logger.child({ component: "cli-tunnel" });
  const now = (): number => deps.clock.now();
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: previewTunnel.messageMaxBytes,
    handleProtocols: (protocols) => (protocols.has(CLI_TUNNEL_SUBPROTOCOL) ? CLI_TUNNEL_SUBPROTOCOL : false),
  });
  const open = new Map<PreviewViewId, Set<OpenCli>>();
  const closeWaitMs = deps.closeWaitMs ?? CLI_TUNNEL_CLOSE_WAIT_MS;
  /** The CLIs' sockets whose cut is already timed. */
  const cutting = new WeakSet<WebSocket>();

  /**
   * Ends a CLI's tunnel here: the close frame with `code`, the HTTP/2 session destroyed with it,
   * and the socket cut once `closeWaitMs` passes without the CLI's answer. Never the session alone,
   * nor the socket alone; again on the same socket, it only makes sure of both.
   */
  const shut = (cli: CliSocket, code: number, text: string): void => {
    const { ws } = cli;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, text);
    }
    if (cli.session !== null && !cli.session.destroyed) {
      cli.session.destroy();
    }
    if (ws.readyState !== WebSocket.CLOSED && !cutting.has(ws)) {
      cutting.add(ws);
      const cut = setTimeout(() => {
        ws.terminate();
      }, closeWaitMs);
      cut.unref();
      ws.once("close", () => {
        clearTimeout(cut);
      });
    }
  };

  /**
   * Serves the CLI's HTTP/2 on its socket here, on the box's session (`TunnelHub.serveCli`):
   * whichever of the session and the socket ends first, the other goes with it.
   */
  const serveHere = (cli: CliSocket, viewId: PreviewViewId, port: number, end: CliTunnelEnd): void => {
    const session = deps.tunnels.serveCli(viewId, port, webSocketDuplex(cli.ws), end);
    if (session === null) {
      end("box-gone");
      return;
    }
    cli.session = session;
    let failed = false;
    session.on("error", () => {
      failed = true;
    });
    // The CLI's own HTTP/2 ended under an open socket: its GOAWAY, or bytes that aren't HTTP/2.
    session.once("close", () => {
      if (failed) {
        logger.info("preview.cli-protocol-error", { viewId });
        shut(cli, PROTOCOL_ERROR.code, PROTOCOL_ERROR.text);
      } else {
        shut(cli, 1000, "closed");
      }
    });
    cli.ws.once("close", () => {
      if (!session.destroyed) {
        session.destroy();
      }
    });
  };

  const closeTheView = (viewId: PreviewViewId): void => {
    closeView(deps, { viewId, reason: "closed" }).catch((error: unknown) => {
      logger.warn("preview.cli-close-failed", { viewId, error: error instanceof Error ? error.name : "unknown" });
    });
  };

  /** The CLI's socket is up: its timers, and the view's close when it goes. */
  const track = (view: CliTunnelView, ws: WebSocket, onEnd: () => void): OpenCli => {
    const timers: ReturnType<typeof setInterval>[] = [];
    const cli: OpenCli = {
      view,
      ws,
      session: null,
      timers,
      end: (reason) => {
        shut(cli, cliTunnelCloseCode(reason), cliTunnelCloseText(reason));
      },
    };
    const set = open.get(view.viewId) ?? new Set<OpenCli>();
    set.add(cli);
    open.set(view.viewId, set);
    const heartbeat = setInterval(() => {
      heartbeatView(deps, { viewId: view.viewId })
        .then((beat) => {
          if (!beat.ok) {
            logger.info("preview.cli-ended", { viewId: view.viewId, reason: "view-closed" });
            cli.end("view-closed");
          }
        })
        .catch((error: unknown) => {
          logger.warn("preview.cli-heartbeat-failed", { viewId: view.viewId, error: error instanceof Error ? error.name : "unknown" });
        });
    }, deps.heartbeatMs ?? PREVIEW_HEARTBEAT_MS);
    const recheck = setInterval(() => {
      checkCliTunnel(deps, view)
        .then((check) => {
          if (!check.ok) {
            logger.info("preview.cli-ended", { viewId: view.viewId, reason: check.reason });
            cli.end("session-ended");
          }
        })
        .catch((error: unknown) => {
          logger.warn("preview.cli-recheck-failed", { viewId: view.viewId, error: error instanceof Error ? error.name : "unknown" });
        });
    }, deps.recheckMs ?? CLI_TUNNEL_RECHECK_MS);
    heartbeat.unref();
    recheck.unref();
    timers.push(heartbeat, recheck);
    // A frame `ws` refuses (bad framing, too large): `ws` sends its close, and the session goes too.
    ws.on("error", () => {
      shut(cli, PROTOCOL_ERROR.code, PROTOCOL_ERROR.text);
    });
    ws.on("close", (code) => {
      for (const timer of timers) {
        clearInterval(timer);
      }
      set.delete(cli);
      if (set.size === 0 && open.get(view.viewId) === set) {
        open.delete(view.viewId);
      }
      logger.info("preview.cli-closed", { viewId: view.viewId, taskId: view.taskId, code });
      onEnd();
      closeTheView(view.viewId);
    });
    return cli;
  };

  /** Where the box's connection is: here (its session ready), another replica, or nowhere yet. */
  const whereIsTheBox = async (viewId: PreviewViewId, socket: Duplex): Promise<{ readonly at: "here" } | { readonly at: "replica"; readonly url: string } | { readonly at: "none" }> => {
    const deadline = Date.now() + deps.presenceWaitMs;
    for (;;) {
      if (socket.destroyed) {
        return { at: "none" };
      }
      if (deps.tunnels.session(viewId) !== null) {
        return { at: "here" };
      }
      const view = await previewViewInTx(deps.db, viewId);
      if (view === null || view.lifecycle.state === "closed") {
        return { at: "none" };
      }
      const me = deps.replicaUrl();
      if (view.replicaUrl !== null && view.replicaUrl !== me) {
        return { at: "replica", url: view.replicaUrl };
      }
      if (Date.now() >= deadline) {
        return { at: "none" };
      }
      // The view's presence (another replica) shows in its row; this replica's own wakes the wait.
      await (view.replicaUrl === me ? deps.tunnels.waitForSession(viewId, 100) : sleep(100));
    }
  };

  /** Opens the signed WebSocket to the replica that holds the box's connection. */
  const dialHolder = async (target: string, view: CliTunnelView): Promise<WebSocket | null> => {
    const path = `${CORE_CLI_TUNNEL_PATH}?view=${encodeURIComponent(view.viewId)}&port=${String(view.port)}`;
    const signature = signReplicaRequest(await deps.secret(), { method: "GET", path, viewId: view.viewId, at: now() });
    const url = `${target.replace(/^http/, "ws")}${path}`;
    return new Promise((resolve) => {
      const ws = new WebSocket(url, [CLI_TUNNEL_SUBPROTOCOL], { headers: { [REPLICA_SIGNATURE_HEADER]: signature }, perMessageDeflate: false, maxPayload: previewTunnel.messageMaxBytes });
      let opened = false;
      const fail = (): void => {
        ws.terminate();
        resolve(null);
      };
      ws.once("open", () => {
        opened = true;
        resolve(ws);
      });
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        fail();
      });
      // Every error is heard, however many a failed handshake emits; after the open, they're the relay's.
      ws.on("error", () => {
        if (!opened) {
          fail();
        }
      });
    });
  };

  const takeTicket = async (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<void> => {
    // A browser's page never opens the CLI's tunnel: it would carry an `Origin`.
    if (request.headers.origin !== undefined) {
      refuseUpgrade(socket, "bad-request");
      return;
    }
    const query = cliTunnelQuerySchema.safeParse({ ticket: url.searchParams.get("ticket") ?? "" });
    if (!query.success || !offers(request, CLI_TUNNEL_SUBPROTOCOL)) {
      refuseUpgrade(socket, "bad-request");
      return;
    }
    const opened = await openCliView(deps, { ticket: query.data.ticket });
    if (!opened.ok) {
      logger.info("preview.cli-refused", { code: opened.error, reason: opened.reason });
      refuseUpgrade(socket, opened.error);
      return;
    }
    const view = opened.view;
    logger.info("preview.cli-opened", { viewId: view.viewId, taskId: view.taskId, port: view.port, memberId: view.memberId, sessionId: view.cliSessionId });
    const box = await whereIsTheBox(view.viewId, socket);
    switch (box.at) {
      case "none":
        logger.info("preview.cli-refused", { viewId: view.viewId, code: "not-connected" });
        closeTheView(view.viewId);
        refuseUpgrade(socket, "not-connected");
        return;
      case "here":
        wss.handleUpgrade(request, socket, head, (ws) => {
          const cli = track(view, ws, () => undefined);
          serveHere(cli, view.viewId, view.port, cli.end);
        });
        return;
      case "replica": {
        const holder = await dialHolder(box.url, view);
        if (holder === null) {
          logger.warn("preview.cli-forward-failed", { viewId: view.viewId });
          closeTheView(view.viewId);
          refuseUpgrade(socket, "forwarding-failed");
          return;
        }
        if (socket.destroyed) {
          holder.close(1000, "closed");
          closeTheView(view.viewId);
          return;
        }
        logger.info("preview.cli-forwarded", { viewId: view.viewId });
        wss.handleUpgrade(request, socket, head, (ws) => {
          const cli = track(view, ws, () => {
            if (holder.readyState === WebSocket.OPEN) {
              holder.close(1000, "closed");
            }
          });
          relay(ws, holder);
          relay(holder, ws);
          // The holder's close code (4401, 4404, 4410, 1001) reaches the CLI as it is, its reason within a close frame's 123 bytes.
          holder.on("close", (code, reason) => {
            shut(cli, code >= 4000 && code <= 4999 ? code : code === 1001 ? 1001 : cliTunnelCloseCode("box-gone"), reason.subarray(0, 120).toString("utf8"));
          });
        });
        return;
      }
      default:
        box satisfies never;
    }
  };

  /** Another replica's CLI, forwarded here, to the box's connection this replica holds. */
  const takeForwarded = async (request: IncomingMessage, socket: Duplex, head: Buffer, url: URL, signature: string | string[]): Promise<void> => {
    const query = forwardedQuerySchema.safeParse({ view: url.searchParams.get("view"), port: url.searchParams.get("port") });
    const verified =
      query.success &&
      typeof signature === "string" &&
      verifyReplicaRequest(await deps.secret(), { method: "GET", path: `${url.pathname}${url.search}`, viewId: query.data.view }, signature, now());
    if (!verified) {
      logger.warn("preview.forward-refused", { route: "cli-tunnel" });
      refuseUpgrade(socket, "ticket-refused");
      return;
    }
    const viewId = query.data.view;
    const view = await previewViewInTx(deps.db, viewId);
    if (view === null || view.lifecycle.state === "closed" || view.mode !== "cli" || (await deps.tunnels.waitForSession(viewId, deps.presenceWaitMs)) === null) {
      refuseUpgrade(socket, "not-connected");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const cli: CliSocket = { ws, session: null };
      ws.on("error", () => {
        shut(cli, PROTOCOL_ERROR.code, PROTOCOL_ERROR.text);
      });
      serveHere(cli, viewId, query.data.port, (reason) => {
        shut(cli, cliTunnelCloseCode(reason), cliTunnelCloseText(reason));
      });
    });
  };

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(request.url ?? "/", "http://ostra.invalid");
    if (url.pathname !== CORE_CLI_TUNNEL_PATH) {
      return false;
    }
    socket.on("error", () => undefined);
    const signature = request.headers[REPLICA_SIGNATURE_HEADER];
    const taken = signature === undefined ? takeTicket(request, socket, head, url) : takeForwarded(request, socket, head, url, signature);
    taken.catch((error: unknown) => {
      logger.error("preview.cli-upgrade-failed", { error: error instanceof Error ? error.name : "unknown" });
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      }
    });
    return true;
  };

  const check = async (): Promise<void> => {
    const viewIds = [...open.keys()];
    if (viewIds.length === 0) {
      return;
    }
    const rows = await deps.db.previewView.findMany({ where: { id: { in: viewIds }, state: "closed" }, select: { id: true } });
    for (const row of rows) {
      const viewId = previewViewIdSchema.parse(row.id);
      for (const cli of open.get(viewId) ?? []) {
        logger.info("preview.cli-ended", { viewId, reason: "view-closed" });
        cli.end("view-closed");
      }
    }
  };

  return {
    handleUpgrade,
    check,
    open: (viewId) => open.get(viewId)?.size ?? 0,
    stop: () => {
      for (const set of open.values()) {
        for (const cli of set) {
          cli.end("server-stopping");
        }
      }
      wss.close();
    },
  };
};
