import { connect as connectHttp2 } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http2";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import type { Duplex } from "node:stream";
import { spliceStreams } from "@ostra/adapter-sdk";
import { previewConnectionQuerySchema, previewPaths, previewSubprotocols, previewTunnel } from "@ostra/protocol";
import type { LeaseEpoch, PreviewViewId } from "@ostra/protocol";
import { WebSocketServer, createWebSocketStream } from "ws";
import type { WebSocket } from "ws";
import type { FakeServer } from "./fake-server.ts";

// Core's side of the preview connection, for the runner's tests (milestone 8, ticket 22): it takes
// `GET /runner/v1/preview?view=&leaseEpoch=` on the fake server as core does, with the tunnel's
// subprotocol, the link's bearer and the view's lease epoch (a stale one gets 409 `stale-lease`,
// an unknown view 404), and opens an HTTP/2 client session on the box's WebSocket, as core's
// `createTunnelHub` does. Its helpers send what core sends on it: a plain `CONNECT`
// (`ostra preview`'s), an extended CONNECT (a browser's WebSocket through the native preview) and a
// plain request. Core's own code against the runner's is `apps/core/src/previews/runner-tunnel.test.ts`.

export type FakePreviewConnection = {
  readonly viewId: PreviewViewId;
  readonly leaseEpoch: number;
  readonly bearer: string | undefined;
  readonly protocol: string;
  readonly ws: WebSocket;
  /** The box's HTTP/2 session, once its SETTINGS arrived. */
  readonly session: Promise<ClientHttp2Session>;
  /** The WebSocket's close code, once it closed. */
  readonly closed: Promise<number>;
};

export type FakeAnswer = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: Buffer };

export type FakePreviewCore = {
  /** Opens a view for the box at `leaseEpoch`: its connection is taken from now. */
  readonly openView: (viewId: PreviewViewId, leaseEpoch: LeaseEpoch) => void;
  /** Every upgrade the box made, in order, taken or refused. */
  readonly upgrades: { readonly viewId: string | null; readonly status: number; readonly protocol: string | null; readonly bearer: string | undefined }[];
  /** The view's connection, once the box opened it. */
  readonly connection: (viewId: PreviewViewId, timeoutMs?: number) => Promise<FakePreviewConnection>;
  /** A plain `CONNECT` to the port: its status, and the stream of raw bytes. */
  readonly connect: (viewId: PreviewViewId, port: number) => Promise<{ readonly status: number; readonly stream: ClientHttp2Stream }>;
  /** An extended CONNECT (RFC 8441) to a WebSocket on the port: its status and answer headers, and the stream. */
  readonly websocket: (
    viewId: PreviewViewId,
    port: number,
    requestPath: string,
    headers?: OutgoingHttpHeaders,
  ) => Promise<{ readonly status: number; readonly headers: IncomingHttpHeaders; readonly stream: ClientHttp2Stream }>;
  /**
   * A plain request to the port, its answer whole. `authority` stands in for `localhost:<port>`, as
   * the native preview sends one for an app with `hostRewrite` off, with the port in its header.
   */
  readonly request: (viewId: PreviewViewId, port: number, requestPath: string, options?: { readonly headers?: OutgoingHttpHeaders; readonly authority?: string }) => Promise<FakeAnswer>;
  /**
   * Listens on `127.0.0.1` and carries each local connection as one plain `CONNECT` to `port`, as
   * `ostra preview` does on the member's machine; resolves with the local port.
   */
  readonly listen: (viewId: PreviewViewId, port: number) => Promise<number>;
  /** Closes the view's connection from core's side. */
  readonly drop: (viewId: PreviewViewId) => void;
  readonly close: () => void;
};

const refuse = (socket: Duplex, status: 400 | 401 | 404 | 409, code: string, currentEpoch?: number): void => {
  const body = JSON.stringify({ error: { code, message: code, ...(currentEpoch === undefined ? {} : { currentEpoch }) } });
  socket.end(`HTTP/1.1 ${String(status)} Refused\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`);
};

const waitUntil = async (check: () => boolean, timeoutMs: number, what: string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`the fake core waited too long for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const answerOf = (stream: ClientHttp2Stream): Promise<FakeAnswer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headers: IncomingHttpHeaders = {};
    stream.on("response", (received) => {
      headers = received;
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      resolve({ status: Number(headers[":status"]), headers, body: Buffer.concat(chunks) });
    });
    stream.on("error", reject);
  });

/** Takes the preview connection's upgrades on the fake server, as core does. */
export const attachFakePreviewCore = (server: FakeServer): FakePreviewCore => {
  const views = new Map<PreviewViewId, LeaseEpoch>();
  const connections = new Map<PreviewViewId, FakePreviewConnection>();
  const upgrades: FakePreviewCore["upgrades"] = [];
  const listeners: Server[] = [];
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: previewTunnel.messageMaxBytes,
    handleProtocols: (protocols) => (protocols.has(previewSubprotocols.tunnel) ? previewSubprotocols.tunnel : false),
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    if (url.pathname !== previewPaths.connection) {
      return;
    }
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
    const offered = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    const protocol = offered.includes(previewSubprotocols.tunnel) ? previewSubprotocols.tunnel : (offered[0] ?? null);
    const query = previewConnectionQuerySchema.safeParse({ view: url.searchParams.get("view"), leaseEpoch: url.searchParams.get("leaseEpoch") });
    const record = (status: number): void => {
      upgrades.push({ viewId: url.searchParams.get("view"), status, protocol, bearer });
    };
    if (!query.success) {
      record(400);
      refuse(socket, 400, "bad-request");
      return;
    }
    if (bearer === undefined || !server.accessTokens.has(bearer)) {
      record(401);
      refuse(socket, 401, "unauthorized");
      return;
    }
    const epoch = views.get(query.data.view);
    if (epoch === undefined) {
      record(404);
      refuse(socket, 404, "not-found");
      return;
    }
    if (epoch !== query.data.leaseEpoch) {
      record(409);
      refuse(socket, 409, "stale-lease", epoch);
      return;
    }
    if (protocol !== previewSubprotocols.tunnel) {
      record(400);
      refuse(socket, 400, "bad-request");
      return;
    }
    record(101);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const duplex = createWebSocketStream(ws);
      duplex.on("error", () => undefined);
      ws.on("error", () => undefined);
      // Core is the client (ADR 0068): the box serves HTTP/2.
      const session = connectHttp2("http://box.invalid", { createConnection: () => duplex });
      session.on("error", () => undefined);
      const ready = new Promise<ClientHttp2Session>((resolve) => {
        session.once("remoteSettings", () => {
          resolve(session);
        });
      });
      const closed = new Promise<number>((resolve) => {
        ws.once("close", (code) => {
          session.destroy();
          resolve(code);
        });
      });
      connections.set(query.data.view, { viewId: query.data.view, leaseEpoch: query.data.leaseEpoch, bearer, protocol, ws, session: ready, closed });
    });
  };
  server.httpServer.on("upgrade", onUpgrade);

  const connection = async (viewId: PreviewViewId, timeoutMs = 30_000): Promise<FakePreviewConnection> => {
    await waitUntil(() => connections.has(viewId), timeoutMs, `the box's connection for ${viewId}`);
    const found = connections.get(viewId);
    if (found === undefined) {
      throw new Error("no connection");
    }
    return found;
  };

  const sessionOf = async (viewId: PreviewViewId): Promise<ClientHttp2Session> => (await connection(viewId)).session;

  return {
    openView: (viewId, leaseEpoch) => {
      views.set(viewId, leaseEpoch);
    },
    upgrades,
    connection,
    connect: async (viewId, port) => {
      const session = await sessionOf(viewId);
      return new Promise((resolve, reject) => {
        const stream = session.request({ ":method": "CONNECT", ":authority": previewTunnel.authority(port) });
        stream.once("response", (headers) => {
          resolve({ status: Number(headers[":status"]), stream });
        });
        stream.once("error", reject);
      });
    },
    websocket: async (viewId, port, requestPath, headers = {}) => {
      const session = await sessionOf(viewId);
      return new Promise((resolve, reject) => {
        const stream = session.request({
          ...headers,
          ":method": "CONNECT",
          ":protocol": "websocket",
          ":scheme": "http",
          ":path": requestPath,
          ":authority": previewTunnel.authority(port),
          "sec-websocket-version": "13",
        });
        stream.once("response", (answered) => {
          resolve({ status: Number(answered[":status"]), headers: answered, stream });
        });
        stream.once("error", reject);
      });
    },
    request: async (viewId, port, requestPath, options = {}) => {
      const session = await sessionOf(viewId);
      const authority = options.authority === undefined ? {} : { [previewTunnel.portHeader]: String(port) };
      const stream = session.request({ ...options.headers, ...authority, ":method": "GET", ":path": requestPath, ":authority": options.authority ?? previewTunnel.authority(port) });
      stream.end();
      return answerOf(stream);
    },
    listen: async (viewId, port) => {
      const session = await sessionOf(viewId);
      return new Promise((resolve) => {
        const listener = createServer((local) => {
          local.on("error", () => undefined);
          const stream = session.request({ ":method": "CONNECT", ":authority": previewTunnel.authority(port) });
          stream.on("error", () => {
            local.destroy();
          });
          stream.on("response", (headers) => {
            if (Number(headers[":status"]) !== 200) {
              local.destroy();
              return;
            }
            spliceStreams(local, stream);
          });
        });
        listeners.push(listener);
        listener.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          resolve(typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0);
        });
      });
    },
    drop: (viewId) => {
      connections.get(viewId)?.ws.close(1000, "closed");
    },
    close: () => {
      server.httpServer.off("upgrade", onUpgrade);
      for (const listener of listeners) {
        listener.close();
      }
      for (const found of connections.values()) {
        found.ws.terminate();
      }
      wss.close();
    },
  };
};
