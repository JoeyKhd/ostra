import { connect as connectHttp2 } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http2";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import type { Duplex } from "node:stream";
import { spliceStreams } from "@ostra/adapter-sdk";
import {
  decodePreviewMessage,
  encodePreviewMessage,
  parseJson,
  PREVIEW_FRAMES_BODY_PART,
  previewConnectionQuerySchema,
  previewFramesBodySchema,
  previewMessageMaxBytes,
  previewPaths,
  previewSubprotocols,
  previewTunnel,
  runnerLimits,
} from "@ostra/protocol";
import type { LeaseEpoch, PreviewClose, PreviewCloseReason, PreviewControl, PreviewFrameHeader, PreviewMode, PreviewViewId } from "@ostra/protocol";
import { WebSocketServer, createWebSocketStream } from "ws";
import type { RawData, WebSocket } from "ws";
import type { FakeServer } from "./fake-server.ts";

// Core's side of the preview connection, for the runner's tests (milestone 8, ticket 22): it takes
// `GET /runner/v1/preview?view=&leaseEpoch=` on the fake server as core does, with the tunnel's
// subprotocol, the link's bearer and the view's lease epoch (a stale one gets 409 `stale-lease`,
// an unknown view 404), and opens an HTTP/2 client session on the box's WebSocket, as core's
// `createTunnelHub` does. Its helpers send what core sends on it: a plain `CONNECT`
// (`ostra preview`'s), an extended CONNECT (a browser's WebSocket through the native preview) and a
// plain request. Core's own code against the runner's is `apps/core/src/previews/runner-tunnel.test.ts`.
//
// Ticket 18: a view opened in `stream` mode (the browser view) takes the stream's subprotocol, and
// the fake keeps every frame the box sends, with when it came; it acks each one as core does, or
// holds its acks while a test says so (core holds them while no panel stream is open); it sends
// core's controls and its close. The HTTP carrier's frames come to `POST /runner/v1/preview/frames`
// on the fake server, read as core reads them (the multipart body, the bearer, the epoch, a closed
// view, at most 2 frames a second for a view), and kept the same way. Core's own code against the
// runner's is `apps/core/src/previews/runner-stream.test.ts`.

/** A frame the box sent, as the fake core took it. */
export type FakeStreamFrame = { readonly header: PreviewFrameHeader; readonly jpeg: Uint8Array; readonly receivedAt: number; readonly carrier: "websocket" | "http" };

/** A browser view as the fake core holds it: its frames, its connection on the WebSocket, and what the box said. */
export type FakeStreamView = {
  readonly viewId: PreviewViewId;
  readonly leaseEpoch: number;
  readonly frames: FakeStreamFrame[];
  /** The controls the box acked, by number. */
  readonly controlAcks: number[];
  /** The box's own `close`, when it sent one. */
  closeReason: PreviewClose["reason"] | null;
  /** The connection's subprotocol and bearer, on the WebSocket. */
  readonly protocol: string | null;
  readonly bearer: string | undefined;
  /** The WebSocket, once the box connected; `null` on the HTTP carrier. */
  ws: WebSocket | null;
  /** The WebSocket's close code, once it closed. */
  readonly closed: Promise<number>;
};

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
  /** Opens a view for the box at `leaseEpoch`, in its mode (`tunnel` by default): its connection is taken from now. */
  readonly openView: (viewId: PreviewViewId, leaseEpoch: LeaseEpoch, mode?: PreviewMode) => void;
  /** Ticket 18: a browser view, once its connection came (or its first frames, on the HTTP carrier). */
  readonly stream: (viewId: PreviewViewId, timeoutMs?: number) => Promise<FakeStreamView>;
  /** Ticket 18: holds a browser view's acks from now (`true`), or lets them go, acking the newest frame (`false`). */
  readonly holdAcks: (viewId: PreviewViewId, hold: boolean) => void;
  /** Ticket 18: sends core's control on a browser view's connection; its number is given here. */
  readonly control: (viewId: PreviewViewId, control: DistributiveOmit<PreviewControl, "seq">) => number;
  /** Ticket 18: ends a browser view as core does: `close` with the reason, then the socket; on HTTP, its next frames get 410. */
  readonly closeStream: (viewId: PreviewViewId, reason: PreviewCloseReason) => void;
  /** Ticket 18: every answer the HTTP carrier's frames got, in order, by view. */
  readonly frameAnswers: (viewId: PreviewViewId) => readonly number[];
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const bytesOf = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return Buffer.isBuffer(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
};

/** A multipart body's parts by name, as core's `multipart.ts` reads them: enough for the box's frames. */
const multipartParts = (body: Buffer, contentType: string): ReadonlyMap<string, Buffer> | null => {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const mark = boundary?.[1] ?? boundary?.[2];
  if (mark === undefined || !contentType.startsWith("multipart/form-data")) return null;
  const delimiter = Buffer.from(`--${mark}`);
  const parts = new Map<string, Buffer>();
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    at += delimiter.length;
    if (body[at] === 0x2d && body[at + 1] === 0x2d) return parts;
    const headersEnd = body.indexOf("\r\n\r\n", at);
    if (headersEnd === -1) return null;
    const name = /name="([^"]+)"/i.exec(body.subarray(at, headersEnd).toString("latin1"))?.[1];
    const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headersEnd + 4);
    if (name === undefined || next === -1) return null;
    parts.set(name, body.subarray(headersEnd + 4, next));
    at = next + 2;
  }
  return null;
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
  const modes = new Map<PreviewViewId, PreviewMode>();
  const connections = new Map<PreviewViewId, FakePreviewConnection>();
  const streams = new Map<PreviewViewId, FakeStreamView>();
  const held = new Set<PreviewViewId>();
  const unacked = new Map<PreviewViewId, number>();
  const closedStreams = new Set<PreviewViewId>();
  const answers = new Map<PreviewViewId, number[]>();
  const httpTimes = new Map<PreviewViewId, number[]>();
  const controlSeqs = new Map<PreviewViewId, number>();
  const upgrades: FakePreviewCore["upgrades"] = [];
  const listeners: Server[] = [];
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: previewTunnel.messageMaxBytes,
    handleProtocols: (protocols) => (protocols.has(previewSubprotocols.tunnel) ? previewSubprotocols.tunnel : false),
  });
  const streamWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: previewMessageMaxBytes,
    handleProtocols: (protocols) => (protocols.has(previewSubprotocols.stream) ? previewSubprotocols.stream : false),
  });

  const sendToBox = (view: FakeStreamView, bytes: Uint8Array): void => {
    if (view.ws !== null && view.ws.readyState === view.ws.OPEN) view.ws.send(bytes);
  };

  /** A browser view's connection: every frame kept and acked (unless held), the box's acks and its close read. */
  const takeStream = (viewId: PreviewViewId, leaseEpoch: number, bearer: string | undefined, protocol: string | null, ws: WebSocket): void => {
    const closed = new Promise<number>((resolve) => {
      ws.once("close", (code) => {
        resolve(code);
      });
    });
    const view: FakeStreamView = { viewId, leaseEpoch, frames: [], controlAcks: [], closeReason: null, protocol, bearer, ws, closed };
    streams.set(viewId, view);
    ws.on("error", () => undefined);
    ws.on("message", (data, isBinary) => {
      const parsed = isBinary ? decodePreviewMessage(bytesOf(data)) : null;
      if (parsed?.ok !== true) {
        ws.close(1008, "protocol violation");
        return;
      }
      const message = parsed.message;
      switch (message.type) {
        case "frame":
          view.frames.push({ header: message.header, jpeg: message.jpeg, receivedAt: Date.now(), carrier: "websocket" });
          if (held.has(viewId)) {
            unacked.set(viewId, message.header.seq);
          } else {
            sendToBox(view, encodePreviewMessage({ type: "ack", ack: { seq: message.header.seq } }));
          }
          return;
        case "ack":
          view.controlAcks.push(message.ack.seq);
          return;
        case "close":
          view.closeReason = message.close.reason;
          return;
        case "control":
          ws.close(1008, "protocol violation");
          return;
        default:
          message satisfies never;
      }
    });
  };

  /** The HTTP carrier's frames, read and answered as core does. */
  const removeRoute = server.addRoute(async (request, response, path) => {
    if (request.method !== "POST" || path !== previewPaths.frames) return false;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const answer = (viewId: PreviewViewId | null, status: number, body: unknown): true => {
      if (viewId !== null) answers.set(viewId, [...(answers.get(viewId) ?? []), status]);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return true;
    };
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
    if (bearer === undefined || !server.accessTokens.has(bearer)) return answer(null, 401, { error: { code: "unauthorized", message: "unauthorized" } });
    const parts = multipartParts(Buffer.concat(chunks), request.headers["content-type"] ?? "");
    const json = parseJson(parts?.get(PREVIEW_FRAMES_BODY_PART)?.toString("utf8") ?? "");
    const body = json.ok ? previewFramesBodySchema.safeParse(json.value) : null;
    if (parts === null || body?.success !== true) return answer(null, 400, { code: "invalid" });
    const { viewId, leaseEpoch, frames } = body.data;
    const epoch = views.get(viewId);
    if (epoch === undefined || closedStreams.has(viewId)) return answer(viewId, 410, { code: "view-closed" });
    if (epoch !== leaseEpoch) return answer(viewId, 409, { code: "stale-lease" });
    const now = Date.now();
    const recent = (httpTimes.get(viewId) ?? []).filter((time) => now - time < 1_000);
    if (recent.length + frames.length > runnerLimits.httpCarrierFramesPerSecond) {
      httpTimes.set(viewId, recent);
      return answer(viewId, 429, { code: "too-fast" });
    }
    httpTimes.set(viewId, [...recent, ...frames.map(() => now)]);
    let view = streams.get(viewId);
    if (view === undefined) {
      view = { viewId, leaseEpoch, frames: [], controlAcks: [], closeReason: null, protocol: null, bearer, ws: null, closed: new Promise<number>(() => undefined) };
      streams.set(viewId, view);
    }
    for (const frame of frames) {
      const jpeg = parts.get(frame.part);
      if (jpeg?.[0] !== 0xff || jpeg[1] !== 0xd8) return answer(viewId, 400, { code: "invalid" });
      view.frames.push({ header: { seq: frame.seq, at: frame.at, width: frame.width, height: frame.height }, jpeg: new Uint8Array(jpeg), receivedAt: now, carrier: "http" });
    }
    return answer(viewId, 200, { ackedUpTo: Math.max(...frames.map((frame) => frame.seq)) });
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(request.url ?? "/", "http://fake.invalid");
    if (url.pathname !== previewPaths.connection) {
      return;
    }
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : undefined;
    const offered = (request.headers["sec-websocket-protocol"] ?? "").split(",").map((part) => part.trim());
    const query = previewConnectionQuerySchema.safeParse({ view: url.searchParams.get("view"), leaseEpoch: url.searchParams.get("leaseEpoch") });
    const wanted = previewSubprotocols[(query.success ? modes.get(query.data.view) : undefined) ?? "tunnel"];
    const protocol = offered.includes(wanted) ? wanted : (offered[0] ?? null);
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
    if (protocol !== wanted) {
      record(400);
      refuse(socket, 400, "bad-request");
      return;
    }
    record(101);
    if (wanted === previewSubprotocols.stream) {
      streamWss.handleUpgrade(request, socket, head, (ws) => {
        takeStream(query.data.view, query.data.leaseEpoch, bearer, protocol, ws);
      });
      return;
    }
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
    openView: (viewId, leaseEpoch, mode = "tunnel") => {
      views.set(viewId, leaseEpoch);
      modes.set(viewId, mode);
    },
    stream: async (viewId, timeoutMs = 30_000) => {
      await waitUntil(() => streams.has(viewId), timeoutMs, `the box's browser view ${viewId}`);
      const found = streams.get(viewId);
      if (found === undefined) throw new Error("no stream");
      return found;
    },
    holdAcks: (viewId, hold) => {
      if (hold) {
        held.add(viewId);
        return;
      }
      held.delete(viewId);
      const seq = unacked.get(viewId);
      const view = streams.get(viewId);
      unacked.delete(viewId);
      if (seq !== undefined && view !== undefined) sendToBox(view, encodePreviewMessage({ type: "ack", ack: { seq } }));
    },
    control: (viewId, control) => {
      const seq = (controlSeqs.get(viewId) ?? 0) + 1;
      controlSeqs.set(viewId, seq);
      const view = streams.get(viewId);
      if (view === undefined) throw new Error("no stream to send a control on");
      sendToBox(view, encodePreviewMessage({ type: "control", control: { ...control, seq } }));
      return seq;
    },
    closeStream: (viewId, reason) => {
      closedStreams.add(viewId);
      const view = streams.get(viewId);
      if (view === undefined) return;
      sendToBox(view, encodePreviewMessage({ type: "close", close: { reason } }));
      view.ws?.close(1000, reason);
    },
    frameAnswers: (viewId) => answers.get(viewId) ?? [],
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
      removeRoute();
      for (const listener of listeners) {
        listener.close();
      }
      for (const found of connections.values()) {
        found.ws.terminate();
      }
      for (const found of streams.values()) {
        found.ws?.terminate();
      }
      wss.close();
      streamWss.close();
    },
  };
};
