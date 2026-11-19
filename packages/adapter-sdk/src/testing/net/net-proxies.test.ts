import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";

import { issueTestCert, makeTestCa } from "./certs.ts";
import type { TestCa, TestCert } from "./certs.ts";
import { startConnectProxy, startNginxDefaults, startTcpProxy, startTlsInspectingProxy, tunnelThrough } from "./net-proxies.ts";
import type { ProxyAuth, Target } from "./net-proxies.ts";

// Ticket 06: a WebSocket upgrade through each of spike 6's networks behaves as the spike recorded
// (`context/research/spike-runner-transport.md`, section 2): through a CONNECT proxy, with and
// without Basic auth, it opens; through a TLS-inspecting proxy it opens (read in clear), is refused
// with an HTML page, or opens and then hears nothing; through nginx's defaults the upgrade is
// stripped and the server answers 426; a cut holds or resets the flow.

const HOST = "ostra-core.test";

const textOf = (data: RawData): string => (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data))).toString("utf8");
const PATH = "/runner/v1/connect";

let serverCa: TestCa;
let corpCa: TestCa;
let corpLeaf: TestCert;
let server: https.Server;
let upstream: Target;
const received: string[] = [];

beforeAll(async () => {
  serverCa = await makeTestCa("ostra-test-server-ca");
  corpCa = await makeTestCa("corp-ca");
  corpLeaf = await issueTestCert(corpCa, [HOST, "localhost", "127.0.0.1"]);
  const leaf = await issueTestCert(serverCa, ["localhost", "127.0.0.1", HOST]);
  // The ostra server's side: the upgrade on its path, and a plain request there answered 426, as core answers it.
  const sockets = new WebSocketServer({ noServer: true });
  sockets.on("connection", (socket) => {
    socket.send("welcome");
    socket.on("message", (data) => {
      const text = textOf(data);
      received.push(text);
      socket.send(`echo:${text}`);
    });
  });
  server = https.createServer({ cert: leaf.cert, key: leaf.key }, (_request, response) => {
    response.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" }).end("Upgrade Required");
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    sockets.handleUpgrade(request, socket, head, (client) => {
      sockets.emit("connection", client, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  upstream = { host: "127.0.0.1", port: typeof address === "object" && address !== null ? address.port : 0 };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

type Outcome =
  | { readonly kind: "open"; readonly socket: WebSocket; readonly first: Promise<string | null> }
  | { readonly kind: "refused"; readonly status: number; readonly body: string }
  | { readonly kind: "error"; readonly message: string };

/** Connects and says how it went; an open socket's first message, or `null` after `quietMs` without one. */
const connect = (url: string, options: { readonly agent?: https.Agent; readonly ca?: string }, quietMs = 1500): Promise<Outcome> =>
  new Promise((resolve) => {
    const socket = new WebSocket(url, { ...(options.agent === undefined ? {} : { agent: options.agent }), ...(options.ca === undefined ? {} : { ca: options.ca }), handshakeTimeout: 5000 });
    const first = new Promise<string | null>((resolveFirst) => {
      const timer = setTimeout(() => {
        resolveFirst(null);
      }, quietMs);
      socket.once("message", (data) => {
        clearTimeout(timer);
        resolveFirst(textOf(data));
      });
    });
    socket.once("open", () => {
      resolve({ kind: "open", socket, first });
    });
    socket.once("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      response.on("end", () => {
        resolve({ kind: "refused", status: response.statusCode ?? 0, body });
      });
    });
    socket.once("error", (error) => {
      resolve({ kind: "error", message: error.message });
    });
  });

const tunnelAgent = (proxyPort: number, ca: string, auth?: ProxyAuth): https.Agent => {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = tunnelThrough({ proxyPort, target: `${HOST}:443`, servername: HOST, ca, ...(auth === undefined ? {} : { auth }) });
  return agent;
};

const hosts = (): ReadonlyMap<string, Target> => new Map([[HOST, upstream]]);

describe("the network proxies of spike 6 (ticket 06)", () => {
  it("F-013: through a CONNECT proxy, a WebSocket opens in one tunnel; with Basic auth it's refused 407 without the credential and opens with it", async () => {
    const open = await startConnectProxy(hosts());
    const guarded = await startConnectProxy(hosts(), { user: "corp", pass: "proxy-secret" });
    try {
      const plain = await connect(`wss://${HOST}${PATH}`, { agent: tunnelAgent(open.port, serverCa.cert) });
      if (plain.kind !== "open") throw new Error(`expected open, got ${JSON.stringify(plain)}`);
      expect(await plain.first).toBe("welcome");
      plain.socket.close();
      expect(open.stats.tunnels).toBe(1);

      const refused = await connect(`wss://${HOST}${PATH}`, { agent: tunnelAgent(guarded.port, serverCa.cert) });
      expect(refused.kind === "error" ? refused.message : JSON.stringify(refused)).toContain("the proxy answered 407");
      expect(guarded.stats.refusedAuth).toBe(1);
      const allowed = await connect(`wss://${HOST}${PATH}`, { agent: tunnelAgent(guarded.port, serverCa.cert, { user: "corp", pass: "proxy-secret" }) });
      if (allowed.kind !== "open") throw new Error(`expected open, got ${JSON.stringify(allowed)}`);
      expect(await allowed.first).toBe("welcome");
      allowed.socket.close();
    } finally {
      await open.close();
      await guarded.close();
    }
  });

  it("F-013: through a TLS-inspecting proxy a WebSocket opens with the corporate CA trusted and is read in clear; switched to block, the upgrade gets its HTML page; switched to hold, it opens and then hears nothing", async () => {
    const proxy = await startTlsInspectingProxy({ hosts: hosts(), leafCert: corpLeaf.cert, leafKey: corpLeaf.key, upstreamCa: serverCa.cert, mode: "pass" });
    const bundle = `${serverCa.cert}\n${corpCa.cert}`;
    try {
      // Without the corporate CA, the proxy's certificate isn't trusted.
      expect(await connect(`wss://${HOST}${PATH}`, { agent: tunnelAgent(proxy.port, serverCa.cert) })).toMatchObject({ kind: "error" });

      const passed = await connect(`wss://${HOST}${PATH}?runner=r1`, { agent: tunnelAgent(proxy.port, bundle) });
      if (passed.kind !== "open") throw new Error(`expected open, got ${JSON.stringify(passed)}`);
      expect(await passed.first).toBe("welcome");
      passed.socket.close();
      expect(proxy.stats.inspectedRequests).toContain(`GET ${PATH} HTTP/1.1`);

      proxy.setMode("block");
      const blocked = await connect(`wss://${HOST}${PATH}`, { agent: tunnelAgent(proxy.port, bundle) });
      expect(blocked).toMatchObject({ kind: "refused", status: 403 });
      expect(blocked.kind === "refused" ? blocked.body : "").toContain("Access denied");
      expect(proxy.stats.blockedUpgrades).toBe(1);

      proxy.setMode("hold");
      const held = await connect(`wss://${HOST}${PATH}`, { agent: tunnelAgent(proxy.port, bundle) }, 800);
      if (held.kind !== "open") throw new Error(`expected open, got ${JSON.stringify(held)}`);
      expect(await held.first).toBeNull();
      expect(proxy.stats.heldBytes).toBeGreaterThan(0);
      held.socket.terminate();
    } finally {
      await proxy.close();
    }
  });

  it("F-013: through nginx's defaults the upgrade is stripped, and the server's 426 comes back", async () => {
    const leaf = await issueTestCert(serverCa, ["localhost", "127.0.0.1"]);
    const nginx = await startNginxDefaults({ upstream: () => upstream, cert: leaf.cert, key: leaf.key, upstreamCa: serverCa.cert });
    try {
      const outcome = await connect(`wss://127.0.0.1:${String(nginx.port)}${PATH}`, { ca: serverCa.cert });
      expect(outcome).toMatchObject({ kind: "refused", status: 426 });
      expect(nginx.stats.inspectedRequests).toContain(`GET ${PATH} (upgrade stripped)`);
    } finally {
      await nginx.close();
    }
  });

  it("F-013: a held cut keeps a frame until the network is back; a reset cut closes the socket, and a new one opens after the restore", async () => {
    const proxy = await startTcpProxy(() => [upstream]);
    try {
      const outcome = await connect(`wss://127.0.0.1:${String(proxy.port)}${PATH}`, { ca: serverCa.cert });
      if (outcome.kind !== "open") throw new Error(`expected open, got ${JSON.stringify(outcome)}`);
      expect(await outcome.first).toBe("welcome");
      proxy.cut("hold");
      outcome.socket.send("during-the-cut");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(received).not.toContain("during-the-cut");
      const echoed = new Promise<string>((resolve) => {
        outcome.socket.once("message", (data) => {
          resolve(textOf(data));
        });
      });
      proxy.restore();
      expect(await echoed).toBe("echo:during-the-cut");

      const closed = new Promise<void>((resolve) => {
        outcome.socket.once("close", () => {
          resolve();
        });
      });
      proxy.cut("reset");
      await closed;
      expect(await connect(`wss://127.0.0.1:${String(proxy.port)}${PATH}`, { ca: serverCa.cert })).toMatchObject({ kind: "error" });
      proxy.restore();
      const again = await connect(`wss://127.0.0.1:${String(proxy.port)}${PATH}`, { ca: serverCa.cert });
      if (again.kind !== "open") throw new Error(`expected open, got ${JSON.stringify(again)}`);
      expect(await again.first).toBe("welcome");
      again.socket.close();
    } finally {
      await proxy.close();
    }
  });
});
