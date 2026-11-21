import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import type { ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders, ServerHttp2Stream } from "node:http2";
import { connect as netConnect, createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { Duplex } from "node:stream";

import { dialApp, spliceStreams, webSocketDuplex } from "@ostra/adapter-sdk";
import { CLI_TUNNEL_SUBPROTOCOL, CORE_CLI_TUNNEL_PATH, previewPaths, previewSubprotocols } from "@ostra/protocol";
import type { PreviewViewId } from "@ostra/protocol";
import WebSocket from "ws";

// The tunnel's test seams (milestone 8, ticket 23): a fake box that opens a view's preview
// connection in `tunnel` mode and serves HTTP/2 on it as the sidecar does (spike 08's sidecar, cut
// down: a plain CONNECT to a raw socket at `localhost`, over IPv6 and IPv4; an extended CONNECT to
// an HTTP/1.1 upgrade; a plain request as HTTP/1.1; a port outside `allow` answered 403), and a
// fake `ostra preview` that opens core's tunnel with a ticket, speaks HTTP/2 on it as the client,
// and turns each local TCP connection into one CONNECT stream. Ticket 22 builds the real sidecar
// and ticket 24 the real CLI. Both run HTTP/2 on their WebSocket through `webSocketDuplex`, as the
// real ones do. And a hostile CLI (the fix after ticket 24): the upgrade by hand on a raw TCP
// socket, then only the bytes a test makes it send, and never an answer to anything core sends.

/** HTTP/2 refuses connection-specific headers (RFC 9113 §8.2.2): each hop drops them. */
const hopByHop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "te", "http2-settings"]);

const forwardable = (headers: IncomingHttpHeaders | IncomingMessage["headers"]): OutgoingHttpHeaders => {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !name.startsWith(":") && !hopByHop.has(name)) {
      out[name] = value;
    }
  }
  return out;
};

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export type FakeTunnelBox = {
  /** The streams the box took, by kind, and the ones it refused. */
  readonly counts: { connects: number; websockets: number; requests: number; refused: number };
  readonly closed: Promise<number>;
  readonly close: () => void;
};

/** A box's preview connection for one tunnel view, serving HTTP/2 as the sidecar (or the `host` runner) does. */
export const connectFakeTunnelBox = (baseUrl: string, viewId: PreviewViewId, leaseEpoch: number, token: string, allow: readonly number[]): Promise<FakeTunnelBox> =>
  new Promise((resolve, reject) => {
    const url = `${baseUrl.replace(/^http/, "ws")}${previewPaths.connection}?view=${encodeURIComponent(viewId)}&leaseEpoch=${String(leaseEpoch)}`;
    const ws = new WebSocket(url, [previewSubprotocols.tunnel], { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false });
    const counts = { connects: 0, websockets: 0, requests: 0, refused: 0 };
    const closed = new Promise<number>((resolveClosed) => {
      ws.on("close", (code) => {
        resolveClosed(code);
      });
    });
    const refuse = (stream: ServerHttp2Stream, status: number): void => {
      counts.refused += 1;
      if (!stream.headersSent) {
        stream.respond({ ":status": status });
      }
      stream.end();
    };
    const server = createHttp2Server({ settings: { enableConnectProtocol: true } });
    server.on("session", (session) => {
      session.on("error", () => undefined);
      session.on("stream", (stream, headers) => {
        stream.on("error", () => undefined);
        const port = Number(/:(\d+)$/.exec(first(headers[":authority"]) ?? "")?.[1]);
        if (!allow.includes(port)) {
          refuse(stream, 403);
          return;
        }
        const method = first(headers[":method"]);
        if (method === "CONNECT" && headers[":protocol"] === undefined) {
          counts.connects += 1;
          const socket = dialApp("localhost", port);
          socket.once("connect", () => {
            stream.respond({ ":status": 200 });
            spliceStreams(socket, stream);
          });
          socket.once("error", () => {
            refuse(stream, 502);
          });
          return;
        }
        const outHeaders = forwardable(headers);
        outHeaders.host = first(headers[":authority"]) ?? `localhost:${String(port)}`;
        if (method === "CONNECT") {
          // An extended CONNECT (RFC 8441): a fresh HTTP/1.1 upgrade to the port, then raw bytes.
          counts.websockets += 1;
          outHeaders.connection = "Upgrade";
          outHeaders.upgrade = "websocket";
          outHeaders["sec-websocket-key"] = randomBytes(16).toString("base64");
          outHeaders["sec-websocket-version"] = "13";
          const upstream = httpRequest({ method: "GET", path: first(headers[":path"]) ?? "/", headers: outHeaders, createConnection: () => dialApp("localhost", port) });
          upstream.on("upgrade", (incoming, socket, head) => {
            const reply: OutgoingHttpHeaders = { ":status": 200 };
            const protocol = first(incoming.headers["sec-websocket-protocol"]);
            if (protocol !== undefined) {
              reply["sec-websocket-protocol"] = protocol;
            }
            stream.respond(reply);
            if (head.length > 0) {
              stream.write(head);
            }
            spliceStreams(socket, stream);
          });
          upstream.on("response", (incoming) => {
            stream.respond({ ...forwardable(incoming.headers), ":status": incoming.statusCode ?? 502 });
            incoming.pipe(stream);
          });
          upstream.on("error", () => {
            refuse(stream, 502);
          });
          upstream.end();
          return;
        }
        counts.requests += 1;
        const upstream = httpRequest({ method: method ?? "GET", path: first(headers[":path"]) ?? "/", headers: outHeaders, createConnection: () => dialApp("localhost", port) });
        upstream.on("response", (incoming) => {
          stream.respond({ ...forwardable(incoming.headers), ":status": incoming.statusCode ?? 502 });
          incoming.pipe(stream);
        });
        upstream.on("error", () => {
          refuse(stream, 502);
        });
        stream.pipe(upstream);
      });
    });
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`upgrade refused: ${String(response.statusCode)}`));
    });
    ws.on("error", (error) => {
      reject(error);
    });
    ws.on("open", () => {
      const duplex = webSocketDuplex(ws);
      server.emit("connection", duplex);
      resolve({
        counts,
        closed,
        close: () => {
          ws.close();
        },
      });
    });
  });

/** Core's refusal of a CLI's tunnel: its status and its JSON body. */
export type CliRefused = { readonly ok: false; readonly status: number; readonly body: unknown };

export type FakeCli = {
  readonly ok: true;
  /** The HTTP/2 session over core's tunnel. */
  readonly session: ClientHttp2Session;
  /** A raw CONNECT stream to `port` of the box, answered with its status. */
  readonly connect: (port: number) => Promise<{ readonly status: number; readonly stream: ReturnType<ClientHttp2Session["request"]> }>;
  /** Listens on `127.0.0.1` and carries each local connection as one CONNECT to `port`; resolves with the local port. */
  readonly listen: (port: number) => Promise<number>;
  /** How the tunnel's WebSocket closed. */
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  readonly close: () => void;
};

/** `ostra preview`'s tunnel, as ticket 24's CLI opens it: the ticket, then HTTP/2 as the client. */
export const openFakeCli = (coreUrl: string, ticket: string, options: { readonly origin?: string; readonly protocol?: string } = {}): Promise<FakeCli | CliRefused> =>
  new Promise((resolve, reject) => {
    const url = `${coreUrl.replace(/^http/, "ws")}${CORE_CLI_TUNNEL_PATH}?ticket=${encodeURIComponent(ticket)}`;
    const ws = new WebSocket(url, [options.protocol ?? CLI_TUNNEL_SUBPROTOCOL], { perMessageDeflate: false, ...(options.origin === undefined ? {} : { origin: options.origin }) });
    const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolveClosed) => {
      ws.on("close", (code, reason) => {
        resolveClosed({ code, reason: reason.toString("utf8") });
      });
    });
    const listeners: Server[] = [];
    ws.on("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: kept as text.
        }
        resolve({ ok: false, status: response.statusCode ?? 0, body });
      });
    });
    ws.on("error", (error) => {
      reject(error);
    });
    ws.on("open", () => {
      const duplex = webSocketDuplex(ws);
      const session = connectHttp2("http://core.invalid", { createConnection: () => duplex });
      session.on("error", () => undefined);
      void closed.then(() => {
        for (const listener of listeners) {
          listener.close();
        }
        session.destroy();
      });
      const connect = (port: number) =>
        new Promise<{ readonly status: number; readonly stream: ReturnType<ClientHttp2Session["request"]> }>((resolveStream, rejectStream) => {
          const stream = session.request({ ":method": "CONNECT", ":authority": `localhost:${String(port)}` });
          stream.on("response", (headers) => {
            resolveStream({ status: Number(headers[":status"]), stream });
          });
          stream.on("error", rejectStream);
        });
      resolve({
        ok: true,
        session,
        connect,
        listen: (port) =>
          new Promise((resolveListening) => {
            const listener = createServer((local) => {
              local.on("error", () => undefined);
              const stream = session.request({ ":method": "CONNECT", ":authority": `localhost:${String(port)}` });
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
              resolveListening(typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0);
            });
          }),
        closed,
        close: () => {
          ws.close();
        },
      });
    });
  });

/** A client's WebSocket frame: FIN, `opcode`, and the payload masked with a fresh key (RFC 6455 §5.3). */
const maskedFrame = (opcode: number, payload: Buffer): Buffer => {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65_536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length < 65_536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([header, mask, masked]);
};

/** The next whole frame core sent (unmasked), or `null` until its bytes are all in. */
const nextFrame = (bytes: Buffer): { readonly opcode: number; readonly payload: Buffer; readonly size: number } | null => {
  if (bytes.length < 2) {
    return null;
  }
  let length = (bytes[1] ?? 0) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (bytes.length < 4) {
      return null;
    }
    length = bytes.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (bytes.length < 10) {
      return null;
    }
    length = Number(bytes.readBigUInt64BE(2));
    offset = 10;
  }
  if (bytes.length < offset + length) {
    return null;
  }
  return { opcode: (bytes[0] ?? 0) & 0x0f, payload: bytes.subarray(offset, offset + length), size: offset + length };
};

/** A CLI no one would ship, on core's tunnel. It never answers a ping or a close frame. */
export type HostileCli = {
  /** Sends `payload` as one masked binary WebSocket message. */
  readonly sendFrame: (payload: Buffer) => void;
  /** Writes `bytes` on the TCP connection as they are: no WebSocket frame. */
  readonly sendRaw: (bytes: Buffer) => void;
  /** An HTTP/2 client session on its binary messages, as a real CLI's: core's first bytes included. */
  readonly http2: () => ClientHttp2Session;
  /** From now on it neither reads nor writes a byte: core's close frame goes unanswered, and nothing else comes. */
  readonly silence: () => void;
  readonly destroy: () => void;
};

/**
 * Opens core's tunnel with `ticket` by hand, on a raw TCP connection: the upgrade's request, core's
 * `101`, and then only what the test sends. Rejects when core refuses the upgrade.
 */
export const openHostileCli = (coreUrl: string, ticket: string): Promise<HostileCli> =>
  new Promise((resolve, reject) => {
    const url = new URL(`${CORE_CLI_TUNNEL_PATH}?ticket=${encodeURIComponent(ticket)}`, coreUrl);
    const socket = netConnect({ host: url.hostname, port: Number(url.port) });
    socket.on("error", () => undefined);
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    let silent = false;
    /** Core's binary messages, kept for the HTTP/2 session until there is one. */
    const early: Buffer[] = [];
    const carried: { duplex: Duplex | null } = { duplex: null };
    const hostile: HostileCli = {
      sendFrame: (payload) => {
        socket.write(maskedFrame(0x2, payload));
      },
      sendRaw: (bytes) => {
        socket.write(bytes);
      },
      http2: () => {
        const duplex = new Duplex({
          read: () => undefined,
          write: (chunk: Buffer, _encoding, callback) => {
            if (!silent) {
              socket.write(maskedFrame(0x2, chunk));
            }
            callback();
          },
          final: (callback) => {
            callback();
          },
        });
        duplex.on("error", () => undefined);
        for (const bytes of early.splice(0)) {
          duplex.push(bytes);
        }
        carried.duplex = duplex;
        const session = connectHttp2("http://core.invalid", { createConnection: () => duplex });
        session.on("error", () => undefined);
        return session;
      },
      silence: () => {
        silent = true;
        socket.removeAllListeners("data");
        socket.pause();
      },
      destroy: () => {
        socket.destroy();
        carried.duplex?.destroy();
      },
    };
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end === -1) {
          return;
        }
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffered.subarray(0, end).toString("latin1"))?.[1] ?? 0);
        buffered = buffered.subarray(end + 4);
        if (status !== 101) {
          socket.destroy();
          reject(new Error(`the tunnel's upgrade was refused: ${String(status)}`));
          return;
        }
        upgraded = true;
        resolve(hostile);
      }
      for (let frame = nextFrame(buffered); frame !== null; frame = nextFrame(buffered)) {
        buffered = buffered.subarray(frame.size);
        // A binary message is the session's; a close frame or a ping is never answered.
        if (frame.opcode === 0x2) {
          if (carried.duplex === null) {
            early.push(frame.payload);
          } else {
            carried.duplex.push(frame.payload);
          }
        }
      }
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${url.pathname}${url.search} HTTP/1.1`,
          `Host: ${url.host}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Protocol: ${CLI_TUNNEL_SUBPROTOCOL}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("close", () => {
      if (!upgraded) {
        reject(new Error("the tunnel's connection closed before its upgrade"));
      }
    });
  });
