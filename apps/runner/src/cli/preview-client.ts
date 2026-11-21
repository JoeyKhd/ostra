import type http from "node:http";
import { connect as connectHttp2 } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { spliceStreams, webSocketDuplex } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { CLI_TUNNEL_SUBPROTOCOL, CORE_CLI_TUNNEL_PATH, cliTunnelErrorSchema, parseJson, previewTunnel } from "@ostra/protocol";
import type { CliTunnelErrorCode } from "@ostra/protocol";
import { WebSocket } from "ws";
import { errorCodeOf } from "../connection/http-carrier.ts";
import { TUNNEL_CONNECTION_WINDOW_BYTES, TUNNEL_STREAM_WINDOW_BYTES } from "../task-host/preview-tunnel.ts";
import { userAgent } from "../version.ts";

// `ostra preview`'s two ends on the member's machine (milestone 8, ticket 24, F-143, ADR 0068
// "`ostra preview`"):
//
// - the tunnel: core's `/cli/v1/tunnel?ticket=…`, a binary WebSocket with the
//   `ostra-cli-tunnel.v1` subprotocol and no `Origin`, whose messages are one HTTP/2 connection with
//   the CLI as the client (core is the server, and bridges each stream to the box). The WebSocket
//   is the session's socket through `webSocketDuplex` (`@ostra/adapter-sdk`), so core's close code
//   (`cliTunnelCloseCodes`) is read as core sent it;
// - the listener: `127.0.0.1` only, never another interface, and each TCP connection it accepts is
//   one plain `CONNECT` stream to the preview's port, joined with `spliceStreams` (never
//   `stream.pipeline`, spike 08 §4.1).
//
// The ticket is in the tunnel's URL and nowhere else: never printed, logged or in an error's words.
// Ports, status codes and counts are logged; a byte of a stream never is.

/** The only address the CLI listens on: this machine's IPv4 loopback (ticket 24). */
export const PREVIEW_LISTEN_HOST = "127.0.0.1";

/** How many ports past the preview's the CLI tries when that one is taken on this machine. */
const NEXT_PORT_TRIES = 20;

/** Core waits up to 10 s for the box before it answers the upgrade: the handshake waits longer. */
const TUNNEL_HANDSHAKE_TIMEOUT_MS = 30_000;

/** Why core's tunnel didn't open. */
export type CliTunnelFailure =
  /** Core refused the upgrade with its error body (`cliTunnelErrorSchema`). */
  | { readonly kind: "refused"; readonly code: CliTunnelErrorCode }
  /** Something answered that isn't core's tunnel: a proxy's page, or an older server. */
  | { readonly kind: "not-ostra"; readonly status: number }
  /** No answer: core's address can't be reached. */
  | { readonly kind: "unreachable"; readonly detail: string };

export type CliTunnel = {
  /** The HTTP/2 session over the tunnel: the CLI is its client. */
  readonly session: ClientHttp2Session;
  /** The WebSocket's close code once the tunnel ended, from either side. */
  readonly ended: Promise<number>;
  /** Ends the tunnel: its streams, then the WebSocket with 1000. */
  readonly close: () => void;
};

export type CliTunnelOpen = { readonly ok: true; readonly tunnel: CliTunnel } | { readonly ok: false; readonly failure: CliTunnelFailure };

/** Core's tunnel address for a ticket: `ws://` or `wss://`, as core's public address is `http://` or `https://`. */
export const cliTunnelUrl = (coreUrl: string, ticket: string): URL => {
  const url = new URL(CORE_CLI_TUNNEL_PATH, coreUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url;
};

/** A refused upgrade's body, read up to a small cap: core's error code, never its words. */
const refusalCodeOf = (response: http.IncomingMessage): Promise<CliTunnelErrorCode | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (): void => {
      const json = parseJson(Buffer.concat(chunks).toString("utf8"));
      const parsed = json.ok ? cliTunnelErrorSchema.safeParse(json.value) : null;
      resolve(parsed?.success === true ? parsed.data.error.code : null);
    };
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024) {
        chunks.push(chunk);
      }
    });
    response.once("end", done);
    response.once("error", done);
  });

/**
 * Opens core's tunnel with a ticket and starts HTTP/2 on it as the client. Resolves once core took
 * the upgrade, or with why it didn't. Never throws.
 */
export const openCliTunnel = (input: { readonly coreUrl: string; readonly ticket: string; readonly agent?: http.Agent; readonly handshakeTimeoutMs?: number }): Promise<CliTunnelOpen> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: CliTunnelOpen): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    let socket: WebSocket;
    try {
      // No `Origin`: core refuses an upgrade that carries one, as a browser's page would.
      socket = new WebSocket(cliTunnelUrl(input.coreUrl, input.ticket), [CLI_TUNNEL_SUBPROTOCOL], {
        headers: { "user-agent": userAgent() },
        perMessageDeflate: false,
        handshakeTimeout: input.handshakeTimeoutMs ?? TUNNEL_HANDSHAKE_TIMEOUT_MS,
        maxPayload: previewTunnel.messageMaxBytes,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      });
    } catch (error) {
      settle({ ok: false, failure: { kind: "unreachable", detail: errorCodeOf(error) } });
      return;
    }
    socket.binaryType = "nodebuffer";
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      void refusalCodeOf(response).then((code) => {
        settle({ ok: false, failure: code === null ? { kind: "not-ostra", status } : { kind: "refused", code } });
        socket.terminate();
      });
    });
    socket.once("error", (error) => {
      settle({ ok: false, failure: { kind: "unreachable", detail: errorCodeOf(error) } });
    });
    socket.once("open", () => {
      if (socket.protocol !== CLI_TUNNEL_SUBPROTOCOL) {
        socket.close(1002, "wrong subprotocol");
        settle({ ok: false, failure: { kind: "not-ostra", status: 101 } });
        return;
      }
      socket.on("error", () => undefined);
      const ended = new Promise<number>((resolveEnded) => {
        socket.once("close", (code) => {
          resolveEnded(code);
        });
      });
      const duplex = webSocketDuplex(socket);
      duplex.on("error", () => undefined);
      const session = connectHttp2("http://core.invalid", { createConnection: () => duplex, settings: { initialWindowSize: TUNNEL_STREAM_WINDOW_BYTES } });
      session.on("error", () => undefined);
      // A large answer (a dev server's bundle) needs more than HTTP/2's 64 KiB connection window.
      session.once("connect", () => {
        session.setLocalWindowSize(TUNNEL_CONNECTION_WINDOW_BYTES);
      });
      // The session ended under a socket that's still open (a protocol error): the tunnel ends with it.
      session.once("close", () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1000, "closed");
        }
      });
      void ended.then(() => {
        if (!session.destroyed) {
          session.destroy();
        }
      });
      settle({
        ok: true,
        tunnel: {
          session,
          ended,
          close: () => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.close(1000, "closed");
            }
            if (!session.destroyed) {
              session.destroy();
            }
          },
        },
      });
    });
  });

/** What the listener carries each local connection on, and what it tells about refused ones. */
export type LocalCarrier = {
  /** The listener's connection handler: the socket is carried now, or once a session is attached. */
  readonly take: (socket: Socket) => void;
  /** The tunnel's session to carry on from now: connections that waited for one go first. */
  readonly attach: (session: ClientHttp2Session) => void;
  /** The tunnel ended: new connections wait for the next session. */
  readonly detach: () => void;
  /** Ends every local connection, carried or waiting. */
  readonly closeAll: () => void;
  /** One CONNECT to the port, its status, then closed: the box's answer that the app is reachable. */
  readonly probe: (timeoutMs: number) => Promise<number | null>;
  readonly counts: { readonly connects: number; readonly refused: number };
};

/** At most this many local connections wait while the tunnel is down; older ones are dropped. */
const MAX_WAITING = 64;

/**
 * Carries each local TCP connection as one plain `CONNECT` stream to `port` (the preview's, on the
 * box) on the tunnel's current session. A stream the box or core refuses (`403` for a port that
 * isn't one of the task's previews, `502` when nothing listens there) closes the local connection,
 * and `onRefused` hears its status.
 */
export const createLocalCarrier = (port: number, onRefused: (status: number) => void, logger: Logger): LocalCarrier => {
  let session: ClientHttp2Session | null = null;
  const sockets = new Set<Socket>();
  const waiting: Socket[] = [];
  const counts = { connects: 0, refused: 0 };

  const request = (on: ClientHttp2Session): ClientHttp2Stream | null => {
    try {
      return on.request({ ":method": "CONNECT", ":authority": previewTunnel.authority(port) });
    } catch {
      return null;
    }
  };

  const carry = (on: ClientHttp2Session, socket: Socket): void => {
    if (socket.destroyed) {
      return;
    }
    const stream = request(on);
    if (stream === null) {
      socket.destroy();
      return;
    }
    let answered = false;
    stream.on("error", () => {
      socket.destroy();
    });
    // The local side gave up before the box answered: its stream goes too. After that, the splice ends it.
    socket.once("close", () => {
      if (!answered && !stream.closed) {
        stream.close();
      }
    });
    stream.once("response", (headers) => {
      answered = true;
      const status = Number(headers[":status"]);
      if (status !== 200) {
        counts.refused += 1;
        logger.info("cli.preview-connect-refused", { port, status });
        stream.close();
        socket.destroy();
        onRefused(status);
        return;
      }
      counts.connects += 1;
      spliceStreams(socket, stream);
    });
  };

  return {
    take: (socket) => {
      socket.on("error", () => undefined);
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
      });
      if (session !== null && !session.destroyed && !session.closed) {
        carry(session, socket);
        return;
      }
      waiting.push(socket);
      while (waiting.length > MAX_WAITING) {
        waiting.shift()?.destroy();
      }
    },
    attach: (next) => {
      session = next;
      for (const socket of waiting.splice(0)) {
        carry(next, socket);
      }
    },
    detach: () => {
      session = null;
    },
    closeAll: () => {
      waiting.length = 0;
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
    probe: (timeoutMs) =>
      new Promise((resolve) => {
        const on = session;
        const stream = on === null ? null : request(on);
        if (stream === null) {
          resolve(null);
          return;
        }
        const timer = setTimeout(() => {
          stream.close();
          resolve(null);
        }, timeoutMs);
        timer.unref();
        stream.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        stream.once("response", (headers) => {
          clearTimeout(timer);
          stream.close();
          resolve(Number(headers[":status"]));
        });
      }),
    counts,
  };
};

type Bound = "listening" | { readonly code: string };

/** Listens on `host:port`, or why not (`EADDRINUSE`, `EACCES`, …). */
const bind = (server: Server, port: number, host: string): Promise<Bound> =>
  new Promise((resolve) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      resolve({ code: errorCodeOf(error) });
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });

/**
 * Whether something on this machine listens on `[::1]:port`. A browser's `localhost` may try IPv6
 * first, so a port taken there would reach that program instead of the preview; a machine with no
 * IPv6 loopback has nothing there.
 */
const takenOnIpv6Loopback = async (port: number): Promise<boolean> => {
  const probe = createServer();
  const bound = await bind(probe, port, "::1");
  if (bound === "listening") {
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    return false;
  }
  return bound.code === "EADDRINUSE" || bound.code === "EACCES";
};

export type LocalListening =
  /** Listening: the address and port it's bound to. */
  | { readonly ok: true; readonly server: Server; readonly host: string; readonly port: number }
  | { readonly ok: false; readonly port: number; readonly code: string };

const boundOf = (server: Server): { readonly host: string; readonly port: number } => {
  const address = server.address();
  return typeof address === "object" && address !== null ? { host: address.address, port: address.port } : { host: "", port: 0 };
};

/**
 * Listens on `127.0.0.1` only, for `onConnection`: on `wanted` when it's free on this machine's
 * loopback (IPv4 and IPv6), else, unless `exact`, the next free port after it, else one the system
 * picks. With `exact` (`--local`), only `wanted`.
 */
export const listenOnLoopback = async (wanted: number, exact: boolean, onConnection: (socket: Socket) => void): Promise<LocalListening> => {
  let last: { readonly port: number; readonly code: string } = { port: wanted, code: "EADDRINUSE" };
  const candidates = exact ? [wanted] : Array.from({ length: NEXT_PORT_TRIES }, (_, index) => wanted + index).filter((port) => port <= 65_535);
  for (const port of [...candidates, ...(exact ? [] : [0])]) {
    if (port !== 0 && (await takenOnIpv6Loopback(port))) {
      last = { port, code: "EADDRINUSE" };
      continue;
    }
    const server = createServer(onConnection);
    const bound = await bind(server, port, PREVIEW_LISTEN_HOST);
    if (bound === "listening") {
      return { ok: true, server, ...boundOf(server) };
    }
    last = { port, code: bound.code };
    if (bound.code !== "EADDRINUSE" && bound.code !== "EACCES") {
      break;
    }
  }
  return { ok: false, ...last };
};
