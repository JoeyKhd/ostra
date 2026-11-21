import { randomBytes } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { constants as http2, createServer as createHttp2Server } from "node:http2";
import type { IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import { dialApp, spliceStreams, webSocketDuplex } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { previewTunnel } from "@ostra/protocol";
import type { PreviewViewId } from "@ostra/protocol";
import type { WebSocket } from "ws";

// The box's side of a tunnel view (milestone 8, ticket 22, F-143, F-144, ADR 0068 "The preview
// connection"), ported from spike 08's sidecar: one HTTP/2 connection on the preview connection's
// WebSocket, with the box (the sidecar, or the runner on `host`) as the server, from Node's own
// `http2` over the WebSocket's duplex stream, `enableConnectProtocol` on (RFC 8441). Core is the
// client. Each stream is one of three kinds:
//
// - a plain request (the native preview's), forwarded to the port as HTTP/1.1 with the headers as
//   core rewrote them, its `:authority` as the `Host`;
// - an extended CONNECT with `:protocol` `websocket`, bridged to a fresh HTTP/1.1 upgrade on the
//   port, then raw bytes both ways;
// - a plain `CONNECT` (`ostra preview`'s), bridged to a raw TCP connection to the port.
//
// Every stream's port is checked by `route` first: the reach rule (`mayReach`), then the box's way
// to it. A refused one is answered 403, which reaches core and the CLI as it is. The two ends of a
// raw stream are joined with `spliceStreams`, never `stream.pipeline` (spike 08 §4.1).
//
// Back-pressure: each stream's own HTTP/2 window, and the WebSocket's send callbacks for the
// connection (`webSocketDuplex`, `@ostra/adapter-sdk`). The box gives each stream a window of
// `TUNNEL_STREAM_WINDOW_BYTES` and the connection `TUNNEL_CONNECTION_WINDOW_BYTES`, so a stream
// whose reader stalls holds its own window and not the connection's: the others go on.
//
// Ports, status codes and counts are logged; a path, a header or a byte of a stream never is.

/** Each stream's receive window the box advertises *(working value)*: a request body or a socket's bytes up from core. */
export const TUNNEL_STREAM_WINDOW_BYTES = 1024 * 1024;
/** The connection's receive window *(working value)*: many streams' windows, so one that stalls never stops the rest. */
export const TUNNEL_CONNECTION_WINDOW_BYTES = 16 * 1024 * 1024;
/** How many HTTP/1.1 connections one tunnel keeps open to one port: Node's agent queues the rest. */
const SOCKETS_PER_PORT = 64;

/** Where a stream to a port goes: the address the box dials. */
export type TunnelDial = { readonly host: string; readonly port: number };

/** A stream's route: where to dial, or the status that refuses it and a reason for the log. */
export type TunnelRoute = { readonly ok: true; readonly dial: TunnelDial } | { readonly ok: false; readonly status: 403 | 502 | 503; readonly reason: string };

export type TunnelOptions = {
  readonly viewId: PreviewViewId;
  /** The view's preview connection, open, in `tunnel` mode. */
  readonly socket: WebSocket;
  /**
   * Where a stream to `port` goes, decided on every stream: the reach rule first (403 for a port
   * that isn't one of the task's previews), then the box's way to it (the forwarder on `docker`).
   */
  readonly route: (port: number) => Promise<TunnelRoute>;
  readonly logger: Logger;
};

export type TunnelCounts = {
  /** Plain requests forwarded as HTTP/1.1. */
  requests: number;
  /** Extended CONNECTs bridged to a WebSocket upgrade. */
  websockets: number;
  /** Plain CONNECTs bridged to a raw connection. */
  connects: number;
  /** Streams refused by the reach rule or a bad `:authority`. */
  refused: number;
  /** Streams whose port couldn't be reached. */
  failed: number;
};

export type Tunnel = {
  readonly counts: Readonly<TunnelCounts>;
  /** Resolves once the connection has ended, from either side. */
  readonly closed: Promise<void>;
  /** Ends the tunnel: every stream, the HTTP/2 session, and the socket with `code`. */
  readonly close: (code: number, reason: string) => void;
};

/** HTTP/2 refuses connection-specific headers (RFC 9113 §8.2.2): each hop drops them, and core's port header. */
const dropped = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "http2-settings", previewTunnel.portHeader]);

/** A message's headers, less the pseudo-headers and the connection's own. */
const forwardable = (headers: IncomingHttpHeaders | IncomingMessage["headers"]): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !name.startsWith(":") && !dropped.has(name)) {
      out[name] = value;
    }
  }
  return out;
};

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** A port from a header's text, or `null`. */
const portOf = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d{1,5}$/.test(text)) {
    return null;
  }
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
};

/**
 * The port a stream asks for: core's port header when it sent one (an app with `hostRewrite` off,
 * whose `:authority` is the preview's own host), else the `:authority`'s, `localhost:<port>`.
 */
export const tunnelTargetPort = (headers: IncomingHttpHeaders): number | null => {
  const named = first(headers[previewTunnel.portHeader]);
  if (named !== undefined) {
    return portOf(named);
  }
  return portOf(/:(\d+)$/.exec(first(headers[":authority"]) ?? "")?.[1]);
};

/** Answers a stream with `status` and ends it, once. */
const answer = (stream: ServerHttp2Stream, status: number): void => {
  if (stream.destroyed || stream.closed) {
    return;
  }
  if (!stream.headersSent) {
    stream.respond({ ":status": status }, { endStream: true });
    return;
  }
  stream.close(http2.NGHTTP2_INTERNAL_ERROR);
};

export const serveTunnel = (options: TunnelOptions): Tunnel => {
  const log = options.logger.child({ component: "preview-tunnel", viewId: options.viewId });
  const counts: TunnelCounts = { requests: 0, websockets: 0, connects: 0, refused: 0, failed: 0 };
  /** One keep-alive agent per dialled address, so a page's many requests reuse their connections. */
  const agents = new Map<string, Agent>();
  const sessions = new Set<ServerHttp2Session>();
  let ended = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const agentFor = (dial: TunnelDial): Agent => {
    const key = `${dial.host}:${String(dial.port)}`;
    let agent = agents.get(key);
    if (agent === undefined) {
      // `localhost` over IPv6 and IPv4 (spike 08 §4.2): a dev server told `localhost` may be on `::1` only.
      agent = new Agent({ keepAlive: true, maxSockets: SOCKETS_PER_PORT, autoSelectFamily: true });
      agents.set(key, agent);
    }
    return agent;
  };

  /** A plain request: HTTP/1.1 to the port, the `:authority` as its `Host`, the answer streamed back. */
  const forward = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, dial: TunnelDial): void => {
    counts.requests += 1;
    const out = forwardable(headers);
    out.host = first(headers[":authority"]) ?? `localhost:${String(dial.port)}`;
    let complete = false;
    const upstream = httpRequest({
      host: dial.host,
      port: dial.port,
      method: first(headers[":method"]) ?? "GET",
      path: first(headers[":path"]) ?? "/",
      headers: out,
      agent: agentFor(dial),
    });
    upstream.on("response", (incoming) => {
      if (stream.destroyed || stream.closed) {
        incoming.destroy();
        return;
      }
      stream.respond({ ...forwardable(incoming.headers), ":status": incoming.statusCode ?? 502 });
      incoming.on("end", () => {
        complete = true;
      });
      incoming.on("error", () => {
        stream.close(http2.NGHTTP2_INTERNAL_ERROR);
      });
      incoming.pipe(stream);
    });
    upstream.on("error", () => {
      counts.failed += 1;
      log.info("preview.tunnel-stream-failed", { kind: "request", port: dial.port });
      answer(stream, 502);
    });
    // Core gave up on the stream before the answer was whole: the app's request goes too.
    stream.on("close", () => {
      if (!complete) {
        upstream.destroy();
      }
    });
    stream.pipe(upstream);
  };

  /** An extended CONNECT (RFC 8441): a fresh HTTP/1.1 upgrade to the port, then the socket's bytes both ways. */
  const upgrade = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, dial: TunnelDial): void => {
    counts.websockets += 1;
    const out = forwardable(headers);
    out.host = first(headers[":authority"]) ?? `localhost:${String(dial.port)}`;
    out.connection = "Upgrade";
    out.upgrade = "websocket";
    out["sec-websocket-key"] = randomBytes(16).toString("base64");
    out["sec-websocket-version"] = "13";
    let bridged = false;
    const upstream = httpRequest({
      host: dial.host,
      port: dial.port,
      method: "GET",
      path: first(headers[":path"]) ?? "/",
      headers: out,
      createConnection: () => dialApp(dial.host, dial.port),
    });
    upstream.on("upgrade", (incoming, socket, head) => {
      if (stream.destroyed || stream.closed) {
        socket.destroy();
        return;
      }
      bridged = true;
      // The app's subprotocol and extensions go back in the CONNECT's answer; the accept key is core's to make.
      const reply: OutgoingHttpHeaders = { ":status": 200 };
      const protocol = first(incoming.headers["sec-websocket-protocol"]);
      const extensions = first(incoming.headers["sec-websocket-extensions"]);
      if (protocol !== undefined) {
        reply["sec-websocket-protocol"] = protocol;
      }
      if (extensions !== undefined) {
        reply["sec-websocket-extensions"] = extensions;
      }
      stream.respond(reply);
      if (head.length > 0) {
        stream.write(head);
      }
      spliceStreams(socket, stream);
    });
    // The app answered the upgrade with a page (a refusal): its status and body reach core.
    upstream.on("response", (incoming) => {
      if (stream.destroyed || stream.closed) {
        incoming.destroy();
        return;
      }
      stream.respond({ ...forwardable(incoming.headers), ":status": incoming.statusCode ?? 502 });
      incoming.pipe(stream);
    });
    upstream.on("error", () => {
      counts.failed += 1;
      log.info("preview.tunnel-stream-failed", { kind: "websocket", port: dial.port });
      answer(stream, 502);
    });
    stream.on("close", () => {
      if (!bridged) {
        upstream.destroy();
      }
    });
    upstream.end();
  };

  /** A plain CONNECT: a raw connection to the port, joined to the stream once it's open. */
  const connect = (stream: ServerHttp2Stream, dial: TunnelDial): void => {
    counts.connects += 1;
    const socket = dialApp(dial.host, dial.port);
    let open = false;
    socket.once("connect", () => {
      if (stream.destroyed || stream.closed) {
        socket.destroy();
        return;
      }
      open = true;
      stream.respond({ ":status": 200 });
      spliceStreams(socket, stream);
    });
    socket.once("error", () => {
      if (!open) {
        counts.failed += 1;
        log.info("preview.tunnel-stream-failed", { kind: "connect", port: dial.port });
        answer(stream, 502);
      }
    });
    stream.on("close", () => {
      if (!open) {
        socket.destroy();
      }
    });
  };

  const onStream = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
    stream.on("error", () => undefined);
    const method = first(headers[":method"]);
    const protocol = first(headers[":protocol"]);
    const port = tunnelTargetPort(headers);
    if (port === null || (method === "CONNECT" && protocol !== undefined && protocol !== "websocket")) {
      counts.refused += 1;
      log.info("preview.tunnel-refused", { reason: port === null ? "no-port" : "unknown-protocol" });
      answer(stream, 400);
      return;
    }
    options
      .route(port)
      .then((route) => {
        if (stream.destroyed || stream.closed) {
          return;
        }
        if (!route.ok) {
          if (route.status === 403) {
            counts.refused += 1;
          } else {
            counts.failed += 1;
          }
          log.info("preview.tunnel-refused", { port, status: route.status, reason: route.reason });
          answer(stream, route.status);
          return;
        }
        if (method !== "CONNECT") {
          forward(stream, headers, route.dial);
        } else if (protocol === "websocket") {
          upgrade(stream, headers, route.dial);
        } else {
          connect(stream, route.dial);
        }
      })
      .catch(() => {
        counts.failed += 1;
        answer(stream, 502);
      });
  };

  const finish = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    for (const session of sessions) {
      if (!session.destroyed) {
        session.destroy();
      }
    }
    sessions.clear();
    for (const agent of agents.values()) {
      agent.destroy();
    }
    agents.clear();
    log.info("preview.tunnel-ended", { ...counts });
    resolveClosed();
  };

  // One server per view, never listening: it turns the WebSocket's bytes into the session's streams.
  const server = createHttp2Server({ settings: { enableConnectProtocol: true, initialWindowSize: TUNNEL_STREAM_WINDOW_BYTES } });
  server.on("session", (session) => {
    sessions.add(session);
    session.setLocalWindowSize(TUNNEL_CONNECTION_WINDOW_BYTES);
    session.on("error", (error: unknown) => {
      log.info("preview.tunnel-session-error", { code: error instanceof Error && "code" in error ? String(error.code) : "unknown" });
    });
    session.on("close", () => {
      sessions.delete(session);
    });
  });
  server.on("stream", onStream);
  const duplex = webSocketDuplex(options.socket);
  duplex.on("error", () => undefined);
  options.socket.on("error", () => undefined);
  options.socket.once("close", finish);
  server.emit("connection", duplex);
  log.info("preview.tunnel-open", {});

  return {
    counts,
    closed,
    close: (code, reason) => {
      // The close frame first, so core reads the code; then the session and every stream go.
      if (options.socket.readyState === options.socket.OPEN) {
        options.socket.close(code, reason);
      }
      finish();
    },
  };
};
