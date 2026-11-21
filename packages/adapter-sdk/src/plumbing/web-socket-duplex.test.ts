import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import type { ServerHttp2Session, ServerHttp2Stream } from "node:http2";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { webSocketDuplex } from "./web-socket-duplex.ts";

// `webSocketDuplex` under HTTP/2, both ends real (the fix after milestone 8's ticket 24): a `ws`
// server whose socket carries an HTTP/2 server session, as core's tunnels do, and a `ws` client
// with an HTTP/2 client session on its own, as `ostra preview` does.

type Served = { readonly ws: WebSocket; readonly session: ServerHttp2Session; readonly stream: ServerHttp2Stream };

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
});

/** A tunnel up, with one stream open from the client: the server's side of it. */
const tunnel = async (): Promise<{ readonly served: Served; readonly closed: Promise<number> }> => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const served = new Promise<Served>((resolve) => {
    http.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const server = createHttp2Server();
        server.on("session", (session) => {
          session.on("error", () => undefined);
          session.on("stream", (stream) => {
            stream.on("error", () => undefined);
            stream.respond({ ":status": 200 });
            resolve({ ws, session, stream });
          });
        });
        server.emit("connection", webSocketDuplex(ws));
      });
    });
  });
  await new Promise<void>((resolve) => {
    http.listen(0, "127.0.0.1", resolve);
  });
  closers.push(() => {
    wss.close();
    http.close();
  });
  const address = http.address();
  const port = typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;
  const client = new WebSocket(`ws://127.0.0.1:${String(port)}/`, { perMessageDeflate: false });
  const closed = new Promise<number>((resolve) => {
    client.on("close", (code) => {
      resolve(code);
    });
  });
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => {
      resolve();
    });
    client.once("error", reject);
  });
  const session = connectHttp2("http://tunnel.invalid", { createConnection: () => webSocketDuplex(client) });
  session.on("error", () => undefined);
  const stream = session.request({ ":path": "/" });
  stream.on("error", () => undefined);
  stream.resume();
  closers.push(() => {
    session.destroy();
    client.terminate();
  });
  return { served: await served, closed };
};

describe("webSocketDuplex", () => {
  it("F-143/c2: a live HTTP/2 session outlives its socket's cut after an unanswered close, and nothing escapes", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const { served } = await tunnel();
      const sessionClosed = new Promise<void>((resolve) => {
        served.session.once("close", resolve);
      });
      // The close frame, then the cut `ws` makes 30 s later when nobody answers, while the session lives.
      served.ws.close(4410, "view closed");
      served.ws.terminate();
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The session's next write: under `createWebSocketStream` it threw ERR_INTERNAL_ASSERTION, uncaught.
      served.stream.write("after the cut\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      served.stream.write("and again\n");
      served.session.destroy();
      await sessionClosed;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it("F-143/c2: destroying it never closes the socket, so the owner's close code reaches the other end", async () => {
    const { served, closed } = await tunnel();
    // The session goes first (as core's tunnels end it), then the socket with its code.
    served.session.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(served.ws.readyState).toBe(WebSocket.OPEN);
    served.ws.close(4410, "view closed");
    expect(await closed).toBe(4410);
  });
});
