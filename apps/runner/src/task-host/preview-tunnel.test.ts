import { createServer as createHttpServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { connect as connectHttp2 } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { leaseEpochSchema, previewSubprotocols, previewTunnel, previewViewIdSchema } from "@ostra/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, createWebSocketStream } from "ws";
import type { WebSocket } from "ws";
import { openPreviewConnection } from "../connection/preview-connection.ts";
import { serveTunnel, tunnelTargetPort } from "./preview-tunnel.ts";
import type { Tunnel, TunnelRoute } from "./preview-tunnel.ts";

// The box's preview connection and its HTTP/2 server on a tunnel view (ticket 22), on their own: a
// core-shaped endpoint on loopback whose HTTP/2 client speaks first as `createTunnelHub` does, and
// an HTTP app on a port of this machine. The whole path through the task host is
// `preview-tunnel.*.test.ts`; core's own code against it is core's `runner-tunnel.test.ts`.

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const listening = (server: HttpServer): Promise<number> =>
  new Promise((resolve) => {
    const address = (): number => {
      const found = server.address();
      return typeof found === "object" && found !== null ? (found satisfies AddressInfo).port : 0;
    };
    if (address() !== 0) {
      resolve(address());
      return;
    }
    server.once("listening", () => {
      resolve(address());
    });
  });

/** An app that answers its path, and a stalled body on `/stall` (a reader that never reads). */
const startApp = async (): Promise<{ readonly port: number; readonly hits: () => number }> => {
  let hits = 0;
  const app = createHttpServer((request, response) => {
    hits += 1;
    if (request.url === "/big") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(4 * 1024 * 1024, 7));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain", "x-host": request.headers.host ?? "" });
    response.end(`you asked for ${request.url ?? ""}`);
  });
  app.listen(0, "localhost");
  closers.push(() => app.close());
  return { port: await listening(app), hits: () => hits };
};

/**
 * Core's preview connection endpoint on loopback, as core's is: the tunnel's subprotocol, the
 * bearer and the epoch checked, a stale epoch refused 409, and core's HTTP/2 client session opened
 * the moment it takes the upgrade, so its preface comes right behind the 101. The box opens it
 * with `openPreviewConnection` and serves the tunnel on it.
 */
const startTunnel = async (route: (port: number) => Promise<TunnelRoute>, records: LogRecord[]): Promise<{ readonly tunnel: Tunnel; readonly session: ClientHttp2Session; readonly core: WebSocket }> => {
  const server = createHttpServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has(previewSubprotocols.tunnel) ? previewSubprotocols.tunnel : false) });
  const accepted = new Promise<{ readonly core: WebSocket; readonly session: ClientHttp2Session }>((resolve) => {
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://core.invalid");
      if (request.headers.authorization !== "Bearer box-token" || url.searchParams.get("view") !== "view-unit") {
        socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      if (url.searchParams.get("leaseEpoch") !== "3") {
        const body = JSON.stringify({ error: { code: "stale-lease", message: "stale", currentEpoch: 3 } });
        socket.end(`HTTP/1.1 409 Conflict\r\ncontent-type: application/json\r\ncontent-length: ${String(body.length)}\r\n\r\n${body}`);
        return;
      }
      wss.handleUpgrade(request, socket, head, (core) => {
        const duplex = createWebSocketStream(core);
        duplex.on("error", () => undefined);
        const session = connectHttp2("http://box.invalid", { createConnection: () => duplex });
        session.on("error", () => undefined);
        resolve({ core, session });
      });
    });
  });
  server.listen(0, "127.0.0.1");
  closers.push(() => server.close());
  const serverUrl = `http://127.0.0.1:${String(await listening(server))}`;
  const viewId = previewViewIdSchema.parse("view-unit");
  // A stale epoch is refused as an event is, with core's epoch.
  expect(await openPreviewConnection({ serverUrl, token: "box-token", viewId, leaseEpoch: leaseEpochSchema.parse(2), mode: "tunnel" })).toEqual({ ok: false, failure: { kind: "stale-lease", currentEpoch: 3 } });
  const opened = await openPreviewConnection({ serverUrl, token: "box-token", viewId, leaseEpoch: leaseEpochSchema.parse(3), mode: "tunnel" });
  if (!opened.ok) throw new Error("not opened");
  const { core, session } = await accepted;
  // Core's preface is already on its way: the box's tunnel starts a few turns later, and reads it all.
  await new Promise((resolve) => setImmediate(resolve));
  const tunnel = serveTunnel({ viewId, socket: opened.socket, route, logger: createLogger((record) => records.push(record)) });
  await new Promise((resolve) => session.once("remoteSettings", resolve));
  closers.push(() => {
    if (core.readyState === core.OPEN) {
      session.destroy();
    }
    core.terminate();
    opened.socket.terminate();
  });
  return { tunnel, session, core };
};

const answerOf = (stream: ClientHttp2Stream): Promise<{ readonly status: number; readonly headers: Record<string, unknown>; readonly body: Buffer }> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let status = 0;
    let headers: Record<string, unknown> = {};
    stream.on("response", (received) => {
      status = Number(received[":status"]);
      headers = received;
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      resolve({ status, headers, body: Buffer.concat(chunks) });
    });
    stream.on("error", reject);
  });

describe("the box's tunnel server", () => {
  it("F-143/c3: reads the port from the :authority, or from core's port header when the authority is the preview's own host", () => {
    expect(tunnelTargetPort({ ":authority": "localhost:5173" })).toBe(5173);
    expect(tunnelTargetPort({ ":authority": "5173-p1.preview.localhost", [previewTunnel.portHeader]: "5174" })).toBe(5174);
    expect(tunnelTargetPort({ ":authority": "localhost" })).toBeNull();
    expect(tunnelTargetPort({ ":authority": "localhost:99999" })).toBeNull();
    expect(tunnelTargetPort({ ":authority": "localhost:5173", [previewTunnel.portHeader]: "nope" })).toBeNull();
  });

  it("F-143/c2: forwards a plain request with its :authority as Host, and a stalled stream never stops the others", async () => {
    const app = await startApp();
    const records: LogRecord[] = [];
    const { tunnel, session } = await startTunnel(() => Promise.resolve({ ok: true, dial: { host: "localhost", port: app.port } }), records);
    const asked = session.request({ ":method": "GET", ":path": "/hello?x=1", ":authority": `localhost:${String(app.port)}` });
    asked.end();
    const answered = await answerOf(asked);
    expect(answered.status).toBe(200);
    expect(answered.headers["x-host"]).toBe(`localhost:${String(app.port)}`);
    expect(answered.body.toString("utf8")).toBe("you asked for /hello?x=1");
    // A 4 MiB answer nobody reads holds its own stream's window, not the connection's: the next request goes through.
    const stalled = session.request({ ":method": "GET", ":path": "/big", ":authority": `localhost:${String(app.port)}` });
    stalled.end();
    stalled.pause();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = session.request({ ":method": "GET", ":path": "/after", ":authority": `localhost:${String(app.port)}` });
    after.end();
    expect((await answerOf(after)).body.toString("utf8")).toBe("you asked for /after");
    stalled.resume();
    expect((await answerOf(stalled)).body.length).toBe(4 * 1024 * 1024);
    expect(tunnel.counts.requests).toBe(3);
    // Ports and counts only: no path in a log line.
    expect(JSON.stringify(records)).not.toContain("/hello");
  });

  it("F-143/c3: answers a refused route's status and never dials", async () => {
    const app = await startApp();
    const { tunnel, session } = await startTunnel(() => Promise.resolve({ ok: false, status: 403, reason: "not-a-preview" }), []);
    const connect = session.request({ ":method": "CONNECT", ":authority": `localhost:${String(app.port)}` });
    expect((await answerOf(connect)).status).toBe(403);
    const plain = session.request({ ":method": "GET", ":path": "/", ":authority": `localhost:${String(app.port)}` });
    plain.end();
    expect((await answerOf(plain)).status).toBe(403);
    expect(app.hits()).toBe(0);
    expect(tunnel.counts.refused).toBe(2);
  });

  it("ends every stream and the socket with the code it's closed with", async () => {
    const app = await startApp();
    const { tunnel, core } = await startTunnel(() => Promise.resolve({ ok: true, dial: { host: "localhost", port: app.port } }), []);
    const closed = new Promise<number>((resolve) => core.once("close", resolve));
    tunnel.close(1001, "the box is stopping");
    expect(await closed).toBe(1001);
    await tunnel.closed;
  });
});
