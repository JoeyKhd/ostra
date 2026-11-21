import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import type { ClientHttp2Session, IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import type { Duplex } from "node:stream";

import { spliceStreams, webSocketDuplex } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { cliTunnelCloseCodes, previewTunnel } from "@ostra/protocol";
import type { CliTunnelCloseReason, PreviewViewId } from "@ostra/protocol";
import type { WebSocket } from "ws";

// One replica's tunnels (milestone 8, ticket 23, F-143, F-144, ADR 0068 "The preview connection"):
// for each view in a tunnel mode whose box connection this replica holds, the HTTP/2 client
// session core opens on the box's WebSocket (the box is the server), kept from the box's SETTINGS
// until the view or the connection ends; and the CLIs' HTTP/2 connections this replica serves for
// that view, as the server, each of their `CONNECT` streams bridged to a `CONNECT` stream on the
// box's session with `spliceStreams` (never `stream.pipeline`, spike 08 §4.1). A CLI reaches only
// its ticket's port. The native preview's proxy (ticket 25) sends its requests on `session(viewId)`.
// Bytes, paths and headers are never logged: IDs, ports and status codes only.
//
// Every session runs on its WebSocket through `webSocketDuplex`, never `ws`'s
// `createWebSocketStream`: under HTTP/2 that one's shutdown hangs once its socket is cut, and the
// session's next write then throws inside Node, uncaught (the fix after ticket 24). A session is
// always destroyed before or with its socket's close, and its socket closes when it ends.

/** How a CLI's tunnel served here ends: the code the CLI's WebSocket closes with, and why. */
export type CliTunnelEnd = (reason: CliTunnelCloseReason | "server-stopping") => void;

type ServedCli = { readonly session: ServerHttp2Session; readonly end: CliTunnelEnd };

type BoxTunnel = {
  readonly viewId: PreviewViewId;
  readonly ws: WebSocket;
  readonly session: ClientHttp2Session;
  /** The box's SETTINGS arrived: streams may open. */
  ready: boolean;
  readonly waiters: Set<() => void>;
  readonly clis: Set<ServedCli>;
};

export type TunnelHub = {
  /** Whether this replica holds the view's box connection in a tunnel mode. */
  readonly holds: (viewId: PreviewViewId) => boolean;
  /** The box's socket for a tunnel view; an older one of the same view is closed. `onGone` runs when it closes. */
  readonly attachBox: (viewId: PreviewViewId, ws: WebSocket, onGone: () => void) => void;
  /** The box's HTTP/2 session for the view, once its SETTINGS arrived; `null` before, or when it isn't here. */
  readonly session: (viewId: PreviewViewId) => ClientHttp2Session | null;
  /** The session once it's ready, within `timeoutMs`; `null` when it isn't by then. */
  readonly waitForSession: (viewId: PreviewViewId, timeoutMs: number) => Promise<ClientHttp2Session | null>;
  /**
   * Serves a CLI's HTTP/2 connection on `duplex` (a `webSocketDuplex`) for the view: each plain
   * `CONNECT` to `port` (the ticket's) is bridged to a `CONNECT` on the box's session. `end` runs
   * when the box's side goes, and the CLI's session is destroyed with it. The CLI's session, for
   * its socket's owner to end with the socket; `null` when this replica doesn't hold the view's.
   */
  readonly serveCli: (viewId: PreviewViewId, port: number, duplex: Duplex, end: CliTunnelEnd) => ServerHttp2Session | null;
  /** Ends the view's tunnel here: GOAWAY and the box's socket closed, and every CLI on it ended with `reason`. */
  readonly close: (viewId: PreviewViewId, reason: CliTunnelCloseReason) => void;
  readonly held: () => readonly PreviewViewId[];
  /** How many CLIs this replica serves on the view (tests and the log). */
  readonly clis: (viewId: PreviewViewId) => number;
  readonly stop: () => void;
};

/** The port a `CONNECT`'s `:authority` names (`host:port`), or `null`. */
const portOfAuthority = (authority: string | undefined): number | null => {
  const found = /:(\d{1,5})$/.exec(authority ?? "");
  const port = Number(found?.[1]);
  return found === null || !Number.isInteger(port) || port < 1 || port > 65_535 ? null : port;
};

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Answers a CLI's stream with `status` and ends it. */
const refuse = (stream: ServerHttp2Stream, status: number): void => {
  if (!stream.headersSent && !stream.destroyed) {
    stream.respond({ ":status": status });
  }
  stream.end();
};

/** A WebSocket close reason for each way a tunnel ends: short, and never content. */
const closeText: Readonly<Record<CliTunnelCloseReason, string>> = { "session-ended": "session ended", "view-closed": "view closed", "box-gone": "box gone" };

export const createTunnelHub = (logger: Logger): TunnelHub => {
  const tunnels = new Map<PreviewViewId, BoxTunnel>();

  const endClis = (tunnel: BoxTunnel, reason: CliTunnelCloseReason | "server-stopping"): void => {
    for (const cli of tunnel.clis) {
      cli.end(reason);
      if (!cli.session.destroyed) {
        cli.session.destroy();
      }
    }
    tunnel.clis.clear();
  };

  const wake = (tunnel: BoxTunnel): void => {
    for (const waiter of tunnel.waiters) {
      waiter();
    }
    tunnel.waiters.clear();
  };

  const bridge = (tunnel: BoxTunnel, port: number, stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
    stream.on("error", () => undefined);
    // Only a plain CONNECT (raw bytes to the port): a request or an extended CONNECT isn't the CLI's.
    if (first(headers[":method"]) !== "CONNECT" || headers[":protocol"] !== undefined) {
      refuse(stream, 405);
      return;
    }
    const asked = portOfAuthority(first(headers[":authority"]));
    if (asked !== port) {
      logger.info("preview.tunnel-refused", { viewId: tunnel.viewId, reason: "port-not-allowed", port: asked ?? 0 });
      refuse(stream, 403);
      return;
    }
    if (!tunnel.ready || tunnel.session.destroyed || tunnel.session.closed) {
      refuse(stream, 503);
      return;
    }
    const upstream = tunnel.session.request({ ":method": "CONNECT", ":authority": previewTunnel.authority(port) });
    upstream.on("error", () => {
      if (!stream.headersSent) {
        refuse(stream, 502);
      } else {
        stream.destroy();
      }
    });
    let answered = false;
    // The CLI gave up before the box answered: the box's stream goes too. After that, the splice ends it.
    stream.on("close", () => {
      if (!answered && !upstream.closed) {
        upstream.close();
      }
    });
    upstream.on("response", (reply) => {
      answered = true;
      const status = reply[":status"] ?? 502;
      if (stream.destroyed) {
        upstream.close();
        return;
      }
      stream.respond({ ":status": status });
      if (status !== 200) {
        // The box refused it (`mayReach`, or the app isn't listening): its status reaches the CLI.
        logger.info("preview.tunnel-refused", { viewId: tunnel.viewId, reason: "box", status, port });
        stream.end();
        upstream.close();
        return;
      }
      spliceStreams(upstream, stream);
    });
  };

  const drop = (tunnel: BoxTunnel, reason: CliTunnelCloseReason | "server-stopping"): void => {
    if (tunnels.get(tunnel.viewId) === tunnel) {
      tunnels.delete(tunnel.viewId);
    }
    tunnel.ready = false;
    wake(tunnel);
    endClis(tunnel, reason);
    if (!tunnel.session.destroyed) {
      tunnel.session.destroy();
    }
  };

  return {
    holds: (viewId) => tunnels.has(viewId),
    attachBox: (viewId, ws, onGone) => {
      const old = tunnels.get(viewId);
      if (old !== undefined && old.ws !== ws) {
        drop(old, "box-gone");
        old.ws.close(4409, "replaced by a newer connection");
      }
      const duplex = webSocketDuplex(ws);
      // Core is the client (ADR 0068): the box's sidecar, or the runner on `host`, serves HTTP/2.
      const session = connectHttp2("http://box.invalid", { createConnection: () => duplex });
      const tunnel: BoxTunnel = { viewId, ws, session, ready: false, waiters: new Set(), clis: new Set() };
      tunnels.set(viewId, tunnel);
      session.on("error", (error: unknown) => {
        logger.warn("preview.tunnel-session-error", { viewId, code: error instanceof Error && "code" in error ? String(error.code) : "unknown" });
      });
      session.once("remoteSettings", () => {
        if (tunnels.get(viewId) === tunnel) {
          tunnel.ready = true;
          logger.info("preview.tunnel-ready", { viewId });
        }
        wake(tunnel);
      });
      // The session ended under a socket that's still open (a GOAWAY, or bytes that aren't HTTP/2): the socket goes too.
      session.on("close", () => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "closed");
        }
      });
      ws.on("error", () => undefined);
      ws.on("close", () => {
        const here = tunnels.get(viewId) === tunnel;
        drop(tunnel, "box-gone");
        if (here) {
          onGone();
        }
      });
    },
    session: (viewId) => {
      const tunnel = tunnels.get(viewId);
      return tunnel?.ready === true && !tunnel.session.destroyed ? tunnel.session : null;
    },
    waitForSession: async (viewId, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const tunnel = tunnels.get(viewId);
        if (tunnel?.ready === true && !tunnel.session.destroyed) {
          return tunnel.session;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          return null;
        }
        // Woken by the box's SETTINGS or its going, else checked again shortly: a box may connect later.
        await new Promise<void>((resolve) => {
          const waiter = (): void => {
            resolve();
          };
          tunnel?.waiters.add(waiter);
          setTimeout(() => {
            tunnel?.waiters.delete(waiter);
            resolve();
          }, Math.min(left, 100)).unref();
        });
      }
    },
    serveCli: (viewId, port, duplex, end) => {
      const tunnel = tunnels.get(viewId);
      if (tunnel?.ready !== true) {
        return null;
      }
      const made: { session: ServerHttp2Session | null } = { session: null };
      // One server per CLI, never listening: it only turns the CLI's bytes into its streams.
      const server = createHttp2Server();
      server.once("session", (session) => {
        const cli: ServedCli = { session, end };
        made.session = session;
        tunnel.clis.add(cli);
        session.on("stream", (stream, headers) => {
          bridge(tunnel, port, stream, headers);
        });
        session.on("error", () => undefined);
        session.on("close", () => {
          tunnel.clis.delete(cli);
        });
      });
      duplex.on("error", () => undefined);
      // The server makes the CLI's session at once, in this call.
      server.emit("connection", duplex);
      return made.session;
    },
    close: (viewId, reason) => {
      const tunnel = tunnels.get(viewId);
      if (tunnel === undefined) {
        return;
      }
      drop(tunnel, reason);
      tunnel.ws.close(1000, closeText[reason]);
    },
    held: () => [...tunnels.keys()],
    clis: (viewId) => tunnels.get(viewId)?.clis.size ?? 0,
    stop: () => {
      for (const tunnel of [...tunnels.values()]) {
        drop(tunnel, "server-stopping");
        tunnel.ws.close(1001, "the server is stopping");
      }
      tunnels.clear();
    },
  };
};

/** The close code a CLI's WebSocket ends with, for each way its tunnel ends. */
export const cliTunnelCloseCode = (reason: CliTunnelCloseReason | "server-stopping"): number => (reason === "server-stopping" ? 1001 : cliTunnelCloseCodes[reason]);

/** The close text that goes with it. */
export const cliTunnelCloseText = (reason: CliTunnelCloseReason | "server-stopping"): string => (reason === "server-stopping" ? "the server is stopping" : closeText[reason]);
