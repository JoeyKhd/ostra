import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

// The networks a runner meets (ticket 06), ported from spike 6 (`spikes/runner-transport/src/
// harness/net-proxies.ts`), all on loopback and all under the test's control:
// - a TCP proxy that can cut the network, holding or resetting every flow
// - a CONNECT proxy, with or without Basic auth
// - a TLS-inspecting proxy with its own CA, which passes WebSockets, blocks their upgrade with an
//   HTML page, or passes the upgrade and then holds every frame; its mode switches at run time
// - nginx's default reverse proxy, emulated (HTTP/1.0 upstream, no Upgrade)
// Spike 6's real-nginx runner isn't ported: it needs a binary (ticket 35's Linux job). Test and dev only.

export type Target = { readonly host: string; readonly port: number };

export type ProxyStats = {
  tunnels: number;
  refusedAuth: number;
  /** Each request line the proxy read in clear, its query left out. */
  inspectedRequests: string[];
  blockedUpgrades: number;
  /** Bytes from the server the hold mode swallowed after an upgrade. */
  heldBytes: number;
};

const newStats = (): ProxyStats => ({ tunnels: 0, refusedAuth: 0, inspectedRequests: [], blockedUpgrades: 0, heldBytes: 0 });

const listen = (server: net.Server, port = 0): Promise<number> =>
  new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

const closeServer = (server: net.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    setTimeout(resolve, 1_000).unref();
  });

// ---------- a TCP proxy with network cuts ----------

/**
 * - `hold`: stop forwarding. Bytes wait, closes wait, new connections hang: the path is gone but no
 *   one says so, and TCP may carry the flow over the gap.
 * - `reset`: the flow dies, as on a NAT rebind or a Wi-Fi roam. The client's side is reset at once;
 *   the server's side goes silent and never carries another byte. New connections are reset until
 *   `restore()`.
 */
export type CutMode = "hold" | "reset";

export type TcpProxy = {
  readonly port: number;
  readonly cut: (mode: CutMode) => void;
  readonly restore: () => void;
  readonly isCut: () => boolean;
  readonly close: () => Promise<void>;
};

type Pair = {
  readonly client: net.Socket;
  upstream: net.Socket | undefined;
  toUpstream: Buffer[];
  toClient: Buffer[];
  clientClosed: boolean;
  upstreamClosed: boolean;
  /** The flow was reset: nothing is forwarded on it again. */
  dead: boolean;
};

/** Forwards each connection to the next of `upstreams`, round robin, trying the others when one refuses. */
export const startTcpProxy = async (upstreams: () => readonly Target[], options: { readonly port?: number } = {}): Promise<TcpProxy> => {
  const state: { cut: boolean; mode: CutMode; next: number } = { cut: false, mode: "hold", next: 0 };
  const pairs = new Set<Pair>();

  const connectUpstream = (pair: Pair, tries: number): void => {
    const list = upstreams();
    if (tries >= list.length || list.length === 0) {
      pair.client.destroy();
      return;
    }
    const target = list[state.next % list.length];
    state.next += 1;
    if (target === undefined) return;
    const upstream = net.connect(target.port, target.host);
    upstream.setNoDelay(true);
    let connected = false;
    upstream.on("connect", () => {
      connected = true;
      pair.upstream = upstream;
      if (pair.clientClosed || pair.dead) {
        upstream.destroy();
        return;
      }
      if (!state.cut) for (const chunk of pair.toUpstream.splice(0)) upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (pair.dead) return;
      if (state.cut) pair.toClient.push(chunk);
      else pair.client.write(chunk);
    });
    upstream.on("error", () => {
      if (!connected) connectUpstream(pair, tries + 1);
    });
    upstream.on("close", () => {
      if (!connected) return;
      pair.upstreamClosed = true;
      if (pair.dead) pairs.delete(pair);
      else if (!state.cut) pair.client.destroy();
    });
  };

  const server = net.createServer((client) => {
    client.on("error", () => undefined);
    if (state.cut && state.mode === "reset") {
      client.resetAndDestroy();
      return;
    }
    client.setNoDelay(true);
    const pair: Pair = { client, upstream: undefined, toUpstream: [], toClient: [], clientClosed: false, upstreamClosed: false, dead: false };
    pairs.add(pair);
    client.on("data", (chunk: Buffer) => {
      if (pair.dead) return;
      if (state.cut || pair.upstream === undefined) pair.toUpstream.push(chunk);
      else pair.upstream.write(chunk);
    });
    client.on("close", () => {
      pair.clientClosed = true;
      if (pair.dead) return;
      if (!state.cut) {
        pair.upstream?.destroy();
        pairs.delete(pair);
      }
    });
    if (!state.cut) connectUpstream(pair, 0);
  });
  const port = await listen(server, options.port);

  return {
    port,
    cut: (mode) => {
      state.cut = true;
      state.mode = mode;
      if (mode !== "reset") return;
      for (const pair of [...pairs]) {
        pair.dead = true;
        pair.toUpstream = [];
        pair.toClient = [];
        pair.client.resetAndDestroy();
        if (pair.upstream === undefined || pair.upstreamClosed) pairs.delete(pair);
      }
    },
    restore: () => {
      state.cut = false;
      for (const pair of [...pairs]) {
        if (pair.dead) continue;
        if (pair.clientClosed) {
          pair.upstream?.destroy();
          pairs.delete(pair);
          continue;
        }
        if (pair.upstream === undefined) {
          connectUpstream(pair, 0);
          continue;
        }
        if (pair.upstreamClosed) {
          pair.client.destroy();
          pairs.delete(pair);
          continue;
        }
        for (const chunk of pair.toUpstream.splice(0)) pair.upstream.write(chunk);
        for (const chunk of pair.toClient.splice(0)) pair.client.write(chunk);
      }
    },
    isCut: () => state.cut,
    close: async () => {
      for (const pair of pairs) {
        pair.client.destroy();
        pair.upstream?.destroy();
      }
      await closeServer(server);
    },
  };
};

// ---------- a CONNECT proxy ----------

export type ProxyAuth = { readonly user: string; readonly pass: string };

export type RunningProxy = { readonly port: number; readonly stats: ProxyStats; readonly close: () => Promise<void> };

const checkAuth = (request: http.IncomingMessage, auth: ProxyAuth | undefined): boolean => {
  if (auth === undefined) return true;
  return request.headers["proxy-authorization"] === `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;
};

const parseAuthority = (url: string | undefined): Target | undefined => {
  const match = /^([^:]+):(\d+)$/.exec(url ?? "");
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { host: match[1], port: Number(match[2]) };
};

/** A CONNECT proxy. `hosts` maps the names it resolves to local targets, since the client itself can't resolve them. */
export const startConnectProxy = async (hosts: ReadonlyMap<string, Target>, auth?: ProxyAuth, options: { readonly port?: number } = {}): Promise<RunningProxy> => {
  const stats = newStats();
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.on("connect", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!checkAuth(request, auth)) {
      stats.refusedAuth += 1;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="ostra-test"\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const authority = parseAuthority(request.url);
    const target = authority === undefined ? undefined : hosts.get(authority.host);
    if (target === undefined) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const upstream = net.connect(target.port, target.host, () => {
      stats.tunnels += 1;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    sockets.add(upstream);
    upstream.on("close", () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    upstream.on("error", () => {
      socket.destroy();
    });
    socket.on("error", () => {
      upstream.destroy();
    });
    socket.on("close", () => {
      upstream.destroy();
    });
  });
  const port = await listen(server, options.port);
  return {
    port,
    stats,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closeServer(server);
    },
  };
};

// ---------- a TLS-inspecting proxy ----------

/** `pass`: decrypts and re-encrypts everything, upgrades included. `block`: refuses every upgrade with an HTML page. `hold`: passes an upgrade's 101, then swallows every byte the server sends on it. */
export type InspectionMode = "pass" | "block" | "hold";

export type InspectingProxy = RunningProxy & {
  readonly mode: () => InspectionMode;
  /** Switches the mode for the tunnels opened from now on. */
  readonly setMode: (mode: InspectionMode) => void;
};

const BLOCK_PAGE =
  "<!doctype html><html><head><title>Blocked</title></head><body><h1>Access denied</h1><p>WebSocket connections are not allowed by your organization's web gateway.</p></body></html>";

const writeRaw = (socket: Duplex, status: string, contentType: string, body: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\ncontent-type: ${contentType}\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`);
};

export const startTlsInspectingProxy = async (input: {
  readonly hosts: ReadonlyMap<string, Target>;
  /** The proxy's own leaf for the names it intercepts, signed by the corporate CA the client trusts. */
  readonly leafCert: string;
  readonly leafKey: string;
  /** The CA the real server's certificate chains to. */
  readonly upstreamCa: string;
  readonly mode: InspectionMode;
  readonly port?: number;
}): Promise<InspectingProxy> => {
  const stats = newStats();
  const state = { mode: input.mode };
  const sockets = new Set<Duplex>();
  const secureContext = tls.createSecureContext({ cert: input.leafCert, key: input.leafKey });
  const upstreamAgent = new https.Agent({ ca: input.upstreamCa, keepAlive: true });

  // The HTTP-aware side, for the mode that blocks WebSockets: it reads every request in clear.
  const inner = http.createServer();
  inner.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => {
    const host = (request.headers.host ?? "").split(":")[0] ?? "";
    const target = input.hosts.get(host);
    stats.inspectedRequests.push(`${request.method ?? ""} ${(request.url ?? "").split("?")[0] ?? ""}`);
    if (target === undefined) {
      response.writeHead(502, { "content-type": "text/html" }).end(BLOCK_PAGE);
      return;
    }
    const upstream = https.request(
      { host: target.host, port: target.port, servername: host, method: request.method, path: request.url, headers: request.headers, agent: upstreamAgent },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/html" });
      response.end(BLOCK_PAGE);
    });
    request.pipe(upstream);
  });
  inner.on("upgrade", (request: http.IncomingMessage, socket: Duplex) => {
    stats.inspectedRequests.push(`${request.method ?? ""} ${(request.url ?? "").split("?")[0] ?? ""} (upgrade)`);
    stats.blockedUpgrades += 1;
    writeRaw(socket, "403 Forbidden", "text/html", BLOCK_PAGE);
  });

  const server = http.createServer((_request, response) => {
    response.writeHead(405).end();
  });
  server.on("connect", (request: http.IncomingMessage, socket: Duplex) => {
    const authority = parseAuthority(request.url);
    const target = authority === undefined ? undefined : input.hosts.get(authority.host);
    if (authority === undefined || target === undefined) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const mode = state.mode;
    stats.tunnels += 1;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const clear = new tls.TLSSocket(socket, { isServer: true, secureContext });
    sockets.add(clear);
    clear.on("error", () => {
      socket.destroy();
    });
    clear.on("close", () => sockets.delete(clear));
    if (mode === "block") {
      inner.emit("connection", clear);
      return;
    }
    // Everything passes, decrypted and encrypted again: the proxy sees every byte.
    const upstream = tls.connect({ host: target.host, port: target.port, servername: authority.host, ca: input.upstreamCa });
    sockets.add(upstream);
    let first = true;
    let isUpgrade = false;
    clear.on("data", (chunk: Buffer) => {
      if (!first) return;
      first = false;
      const text = chunk.toString("latin1");
      isUpgrade = /\r\nupgrade:\s*websocket/i.test(text);
      stats.inspectedRequests.push((text.split("\r\n")[0] ?? "").replace(/\?\S*/, ""));
    });
    clear.pipe(upstream);
    // Server to client. In the hold mode an upgrade's response head passes, and every byte after
    // it (the welcome, the pings, the acks) is swallowed.
    let head = Buffer.alloc(0);
    let headDone = false;
    upstream.on("data", (chunk: Buffer) => {
      if (mode !== "hold" || !isUpgrade) {
        clear.write(chunk);
        return;
      }
      if (headDone) {
        stats.heldBytes += chunk.length;
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      headDone = true;
      clear.write(head.subarray(0, end + 4));
      stats.heldBytes += head.length - end - 4;
    });
    upstream.on("end", () => {
      clear.end();
    });
    upstream.on("error", () => {
      clear.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      clear.destroy();
    });
  });
  const port = await listen(server, input.port);
  return {
    port,
    stats,
    mode: () => state.mode,
    setMode: (mode) => {
      state.mode = mode;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      upstreamAgent.destroy();
      server.closeAllConnections();
      inner.closeAllConnections();
      await closeServer(server);
    },
  };
};

// ---------- nginx's defaults, emulated ----------

const HOP = new Set(["connection", "keep-alive", "upgrade", "proxy-connection", "te", "trailer", "transfer-encoding", "proxy-authorization"]);

const NGINX_502 = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";
const NGINX_504 = "<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

/**
 * What `location / { proxy_pass https://upstream; }` does with nothing else set: HTTP/1.0 to the
 * upstream with `Connection: close`, no Upgrade passed, the request body and the whole response
 * buffered, and a 60 s read timeout.
 */
export const startNginxDefaults = async (input: {
  readonly upstream: () => Target;
  readonly cert: string;
  readonly key: string;
  readonly upstreamCa: string;
  readonly port?: number;
}): Promise<RunningProxy> => {
  const stats = newStats();

  const forward = (request: http.IncomingMessage, body: Buffer, reply: (status: number, headers: http.OutgoingHttpHeaders, data: Buffer) => void): void => {
    const target = input.upstream();
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(request.headers)) if (!HOP.has(key) && value !== undefined) headers[key] = value;
    headers.host = `${target.host}:${String(target.port)}`;
    headers.connection = "close";
    headers["content-length"] = String(body.length);
    stats.inspectedRequests.push(`${request.method ?? ""} ${(request.url ?? "").split("?")[0] ?? ""}${request.headers.upgrade === undefined ? "" : " (upgrade stripped)"}`);
    const upstream = https.request(
      { host: target.host, port: target.port, method: request.method, path: request.url, headers, ca: input.upstreamCa, agent: false, servername: "localhost" },
      (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => {
          const out: http.OutgoingHttpHeaders = {};
          for (const [key, value] of Object.entries(answer.headers)) if (!HOP.has(key) && value !== undefined) out[key] = value;
          reply(answer.statusCode ?? 502, out, Buffer.concat(chunks));
        });
      },
    );
    upstream.setTimeout(60_000, () => {
      upstream.destroy();
      reply(504, { "content-type": "text/html" }, Buffer.from(NGINX_504));
    });
    upstream.on("error", () => {
      reply(502, { "content-type": "text/html" }, Buffer.from(NGINX_502));
    });
    upstream.end(body);
  };

  const readAll = (request: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
      request.on("error", () => {
        resolve(Buffer.alloc(0));
      });
    });

  const server = https.createServer({ cert: input.cert, key: input.key }, (request, response) => {
    void readAll(request).then((body) => {
      forward(request, body, (status, headers, data) => {
        if (response.headersSent) return;
        response.writeHead(status, { ...headers, "content-length": String(data.length), server: "nginx" });
        response.end(data);
      });
    });
  });
  server.on("upgrade", (request: http.IncomingMessage, socket: Duplex) => {
    let sent = false;
    forward(request, Buffer.alloc(0), (status, headers, data) => {
      if (sent) return;
      sent = true;
      const head = Object.entries({ ...headers, "content-length": String(data.length), connection: "close", server: "nginx" })
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
        .join("\r\n");
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${String(status)} ${http.STATUS_CODES[status] ?? ""}\r\n${head}\r\n\r\n`), data]));
    });
    socket.on("error", () => undefined);
  });
  const port = await listen(server, input.port);
  return {
    port,
    stats,
    close: async () => {
      server.closeAllConnections();
      await closeServer(server);
    },
  };
};

// ---------- a client's tunnel ----------

/**
 * A `createConnection` for an `https.Agent` (which `ws` takes as its `agent`): it opens a CONNECT
 * tunnel through a proxy and speaks TLS to `target` inside it, as a runner behind `HTTPS_PROXY` does.
 */
export const tunnelThrough =
  (input: { readonly proxyPort: number; readonly target: string; readonly servername: string; readonly ca: string; readonly auth?: ProxyAuth }) =>
  (_options: http.ClientRequestArgs, done?: (error: Error | null, socket: Duplex) => void): undefined => {
    const finish = done ?? (() => undefined);
    const request = http.request({
      host: "127.0.0.1",
      port: input.proxyPort,
      method: "CONNECT",
      path: input.target,
      headers: input.auth === undefined ? {} : { "proxy-authorization": `Basic ${Buffer.from(`${input.auth.user}:${input.auth.pass}`).toString("base64")}` },
    });
    request.once("connect", (answer, socket) => {
      if (answer.statusCode !== 200) {
        socket.destroy();
        finish(new Error(`the proxy answered ${String(answer.statusCode)}`), socket);
        return;
      }
      const secure = tls.connect({ socket, servername: input.servername, ca: input.ca }, () => {
        finish(null, secure);
      });
      secure.once("error", (error) => {
        finish(error, secure);
      });
    });
    request.once("error", (error) => {
      finish(error, new net.Socket());
    });
    request.end();
    return undefined;
  };
