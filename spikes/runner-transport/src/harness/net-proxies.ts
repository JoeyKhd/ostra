// The networks a runner meets, all local and all under the harness's control:
// - a TCP load balancer that can cut the network (round-robin, failover)
// - a CONNECT proxy, with or without Basic auth
// - a TLS-inspecting proxy with its own CA, which passes WebSockets, blocks them,
//   or accepts the upgrade and then holds every frame
// - an emulation of nginx's default reverse proxy (HTTP/1.0 upstream, no Upgrade)
// - real nginx, when NGINX_BIN names one

import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { killTree, spawnProcess } from "./procs.ts";
import { freePort } from "./postgres.ts";

export type Target = { readonly host: string; readonly port: number };

const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a !== null ? a.port : 0);
    });
  });

const closeServer = (server: net.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    setTimeout(resolve, 1_000).unref();
  });

// ---------- TCP load balancer with network cuts ----------

/**
 * - `hold`: stop forwarding. Bytes wait, closes wait, new connections hang: the
 *   path is gone but no one says so, and TCP may carry the flow over the gap.
 * - `reset`: the flow dies, as on a NAT rebind or a Wi-Fi roam. The runner's
 *   side is reset at once; the server's side goes silent (a dropped flow says
 *   nothing to the far end) and never carries another byte. New connections are
 *   reset until `restore()`.
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

export const tcpProxy = async (upstreams: () => readonly Target[]): Promise<TcpProxy> => {
  let cutNow = false;
  let cutMode: CutMode = "hold";
  let rr = 0;
  const pairs = new Set<Pair>();

  const connectUpstream = (pair: Pair, tries: number): void => {
    const list = upstreams();
    if (tries >= list.length || list.length === 0) {
      pair.client.destroy();
      return;
    }
    const target = list[rr % list.length];
    rr += 1;
    if (target === undefined) return;
    const u = net.connect(target.port, target.host);
    u.setNoDelay(true);
    let connected = false;
    u.on("connect", () => {
      connected = true;
      pair.upstream = u;
      if (pair.clientClosed || pair.dead) {
        u.destroy();
        return;
      }
      if (!cutNow) for (const b of pair.toUpstream.splice(0)) u.write(b);
    });
    u.on("data", (d: Buffer) => {
      if (pair.dead) return;
      if (cutNow) pair.toClient.push(d);
      else pair.client.write(d);
    });
    u.on("error", () => {
      if (!connected) connectUpstream(pair, tries + 1);
    });
    u.on("close", () => {
      if (!connected) return;
      pair.upstreamClosed = true;
      if (pair.dead) pairs.delete(pair);
      else if (!cutNow) pair.client.destroy();
    });
  };

  const server = net.createServer((client) => {
    client.on("error", () => undefined);
    if (cutNow && cutMode === "reset") {
      client.resetAndDestroy();
      return;
    }
    client.setNoDelay(true);
    const pair: Pair = { client, upstream: undefined, toUpstream: [], toClient: [], clientClosed: false, upstreamClosed: false, dead: false };
    pairs.add(pair);
    client.on("data", (d: Buffer) => {
      if (pair.dead) return;
      if (cutNow || pair.upstream === undefined) pair.toUpstream.push(d);
      else pair.upstream.write(d);
    });
    client.on("close", () => {
      pair.clientClosed = true;
      if (pair.dead) return;
      if (!cutNow) {
        pair.upstream?.destroy();
        pairs.delete(pair);
      }
    });
    if (!cutNow) connectUpstream(pair, 0);
  });
  const port = await listen(server);

  return {
    port,
    cut: (mode) => {
      cutNow = true;
      cutMode = mode;
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
      cutNow = false;
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
        for (const b of pair.toUpstream.splice(0)) pair.upstream.write(b);
        for (const b of pair.toClient.splice(0)) pair.client.write(b);
      }
    },
    isCut: () => cutNow,
    close: async () => {
      for (const p of pairs) {
        p.client.destroy();
        p.upstream?.destroy();
      }
      await closeServer(server);
    },
  };
};

// ---------- CONNECT proxy ----------

export type ProxyStats = { tunnels: number; refusedAuth: number; inspectedRequests: string[]; blockedUpgrades: number; heldBytes: number };

const writeRaw = (socket: Duplex, status: string, contentType: string, body: string): void => {
  socket.end(
    `HTTP/1.1 ${status}\r\ncontent-type: ${contentType}\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`,
  );
};

const checkAuth = (req: http.IncomingMessage, auth: { user: string; pass: string } | undefined): boolean => {
  if (auth === undefined) return true;
  const want = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;
  return req.headers["proxy-authorization"] === want;
};

const parseAuthority = (url: string | undefined): { host: string; port: number } | undefined => {
  const m = /^([^:]+):(\d+)$/.exec(url ?? "");
  if (m?.[1] === undefined || m[2] === undefined) return undefined;
  return { host: m[1], port: Number(m[2]) };
};

/** `hosts` maps the names the proxy resolves to local targets: the runner itself can't resolve them. */
export const connectProxy = async (
  hosts: ReadonlyMap<string, Target>,
  auth: { user: string; pass: string } | undefined,
): Promise<{ port: number; stats: ProxyStats; close: () => Promise<void> }> => {
  const stats: ProxyStats = { tunnels: 0, refusedAuth: 0, inspectedRequests: [], blockedUpgrades: 0, heldBytes: 0 };
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!checkAuth(req, auth)) {
      stats.refusedAuth += 1;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="spike"\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const a = parseAuthority(req.url);
    const target = a === undefined ? undefined : hosts.get(a.host);
    if (target === undefined) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    const u = net.connect(target.port, target.host, () => {
      stats.tunnels += 1;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) u.write(head);
      socket.pipe(u).pipe(socket);
    });
    sockets.add(u);
    u.on("close", () => {
      sockets.delete(u);
      socket.destroy();
    });
    u.on("error", () => {
      socket.destroy();
    });
    socket.on("error", () => {
      u.destroy();
    });
    socket.on("close", () => {
      u.destroy();
    });
  });
  const port = await listen(server);
  return {
    port,
    stats,
    close: async () => {
      for (const s of sockets) s.destroy();
      server.closeAllConnections();
      await closeServer(server);
    },
  };
};

// ---------- TLS-inspecting proxy ----------

const BLOCK_PAGE =
  "<!doctype html><html><head><title>Blocked</title></head><body><h1>Access denied</h1><p>WebSocket connections are not allowed by your organization's web gateway.</p></body></html>";

export const tlsInspectingProxy = async (o: {
  readonly hosts: ReadonlyMap<string, Target>;
  readonly leafCert: string;
  readonly leafKey: string;
  readonly upstreamCa: string;
  readonly blockUpgrades: boolean;
  /** Pass the upgrade's 101, then forward nothing from the server on that tunnel. */
  readonly holdFrames: boolean;
}): Promise<{ port: number; stats: ProxyStats; close: () => Promise<void> }> => {
  const stats: ProxyStats = { tunnels: 0, refusedAuth: 0, inspectedRequests: [], blockedUpgrades: 0, heldBytes: 0 };
  const sockets = new Set<Duplex>();
  const secureContext = tls.createSecureContext({ cert: o.leafCert, key: o.leafKey });
  const upstreamAgent = new https.Agent({ ca: o.upstreamCa, keepAlive: true });

  // The HTTP-aware side, for the mode that blocks WebSockets: it reads every request in clear.
  const inner = http.createServer();
  inner.on("request", (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const target = o.hosts.get(host);
    stats.inspectedRequests.push(`${req.method ?? ""} ${(req.url ?? "").split("?")[0] ?? ""}`);
    if (target === undefined) {
      res.writeHead(502, { "content-type": "text/html" });
      res.end(BLOCK_PAGE);
      return;
    }
    const up = https.request(
      { host: target.host, port: target.port, servername: host, method: req.method, path: req.url, headers: req.headers, agent: upstreamAgent },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/html" });
      res.end(BLOCK_PAGE);
    });
    req.pipe(up);
  });
  inner.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
    stats.inspectedRequests.push(`${req.method ?? ""} ${(req.url ?? "").split("?")[0] ?? ""} (upgrade)`);
    stats.blockedUpgrades += 1;
    writeRaw(socket, "403 Forbidden", "text/html", BLOCK_PAGE);
  });

  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req: http.IncomingMessage, socket: Duplex) => {
    const a = parseAuthority(req.url);
    const target = a === undefined ? undefined : o.hosts.get(a.host);
    if (a === undefined || target === undefined) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    stats.tunnels += 1;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const clear = new tls.TLSSocket(socket, { isServer: true, secureContext });
    sockets.add(clear);
    clear.on("error", () => {
      socket.destroy();
    });
    clear.on("close", () => sockets.delete(clear));
    if (o.blockUpgrades) {
      inner.emit("connection", clear);
      return;
    }
    // Pass everything through, decrypted and re-encrypted: the proxy sees every byte.
    const up = tls.connect({ host: target.host, port: target.port, servername: a.host, ca: o.upstreamCa });
    sockets.add(up);
    let first = true;
    let isUpgrade = false;
    clear.on("data", (d: Buffer) => {
      if (first) {
        first = false;
        const text = d.toString("latin1");
        isUpgrade = /\r\nupgrade:\s*websocket/i.test(text);
        const line = text.split("\r\n")[0] ?? "";
        stats.inspectedRequests.push(line.replace(/\?.*? /, " "));
      }
    });
    clear.pipe(up);
    // Server to client. In holdFrames mode an upgrade's response head passes,
    // and every byte after it (the welcome, pings, acks) is swallowed.
    let head = Buffer.alloc(0);
    let headDone = false;
    up.on("data", (d: Buffer) => {
      if (!o.holdFrames || !isUpgrade) {
        clear.write(d);
        return;
      }
      if (headDone) {
        stats.heldBytes += d.length;
        return;
      }
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      headDone = true;
      clear.write(head.subarray(0, end + 4));
      stats.heldBytes += head.length - end - 4;
    });
    up.on("end", () => {
      clear.end();
    });
    up.on("error", () => {
      clear.destroy();
    });
    up.on("close", () => {
      sockets.delete(up);
      clear.destroy();
    });
  });
  const port = await listen(server);
  return {
    port,
    stats,
    close: async () => {
      for (const s of sockets) s.destroy();
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
 * What `location / { proxy_pass https://upstream; }` does with nothing else set:
 * HTTP/1.0 to the upstream with `Connection: close`, no Upgrade passed, the
 * request body and the whole response buffered, and a 60 s read timeout.
 */
export const nginxDefaultsEmulation = async (o: {
  readonly upstream: () => Target;
  readonly cert: string;
  readonly key: string;
  readonly upstreamCa: string;
}): Promise<{ port: number; stats: ProxyStats; close: () => Promise<void> }> => {
  const stats: ProxyStats = { tunnels: 0, refusedAuth: 0, inspectedRequests: [], blockedUpgrades: 0, heldBytes: 0 };

  const forward = (req: http.IncomingMessage, body: Buffer, reply: (status: number, headers: http.OutgoingHttpHeaders, data: Buffer) => void): void => {
    const t = o.upstream();
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    headers.host = `${t.host}:${String(t.port)}`;
    headers.connection = "close";
    headers["content-length"] = String(body.length);
    stats.inspectedRequests.push(`${req.method ?? ""} ${(req.url ?? "").split("?")[0] ?? ""}${req.headers.upgrade === undefined ? "" : " (upgrade stripped)"}`);
    const up = https.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers, ca: o.upstreamCa, agent: false, servername: "localhost" }, (ur) => {
      const chunks: Buffer[] = [];
      ur.on("data", (c: Buffer) => chunks.push(c));
      ur.on("end", () => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
        reply(ur.statusCode ?? 502, out, Buffer.concat(chunks));
      });
    });
    up.setTimeout(60_000, () => {
      up.destroy();
      reply(504, { "content-type": "text/html" }, Buffer.from(NGINX_504));
    });
    up.on("error", () => {
      reply(502, { "content-type": "text/html" }, Buffer.from(NGINX_502));
    });
    up.end(body);
  };

  const readAll = (req: http.IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        resolve(Buffer.concat(chunks));
      });
      req.on("error", () => {
        resolve(Buffer.alloc(0));
      });
    });

  const server = https.createServer({ cert: o.cert, key: o.key }, (req, res) => {
    void readAll(req).then((body) => {
      forward(req, body, (status, headers, data) => {
        if (res.headersSent) return;
        res.writeHead(status, { ...headers, "content-length": String(data.length), server: "nginx" });
        res.end(data);
      });
    });
  });
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex) => {
    let sent = false;
    forward(req, Buffer.alloc(0), (status, headers, data) => {
      if (sent) return;
      sent = true;
      const head = Object.entries({ ...headers, "content-length": String(data.length), connection: "close", server: "nginx" })
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
        .join("\r\n");
      socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${String(status)} ${http.STATUS_CODES[status] ?? ""}\r\n${head}\r\n\r\n`), data]));
    });
    socket.on("error", () => undefined);
  });
  const port = await listen(server);
  return {
    port,
    stats,
    close: async () => {
      server.closeAllConnections();
      await closeServer(server);
    },
  };
};

// ---------- real nginx ----------

const accepts = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      resolve(false);
    });
  });

/** Real nginx with only `proxy_pass` set, when NGINX_BIN names a binary. */
export const realNginx = async (o: {
  readonly bin: string;
  readonly dir: string;
  readonly upstream: Target;
  readonly cert: string;
  readonly key: string;
}): Promise<{ port: number; close: () => Promise<void> }> => {
  const port = await freePort();
  for (const d of ["conf", "logs", "temp"]) await mkdir(path.join(o.dir, d), { recursive: true });
  const fwd = (p: string): string => p.replaceAll("\\", "/");
  const conf = [
    "worker_processes 1;",
    "daemon off;",
    `error_log ${fwd(path.join(o.dir, "logs", "error.log"))};`,
    `pid ${fwd(path.join(o.dir, "logs", "nginx.pid"))};`,
    "events { worker_connections 1024; }",
    "http {",
    "  access_log off;",
    `  client_body_temp_path ${fwd(path.join(o.dir, "temp"))};`,
    `  proxy_temp_path ${fwd(path.join(o.dir, "temp"))};`,
    "  server {",
    `    listen 127.0.0.1:${String(port)} ssl;`,
    `    ssl_certificate ${fwd(o.cert)};`,
    `    ssl_certificate_key ${fwd(o.key)};`,
    `    location / { proxy_pass https://${o.upstream.host}:${String(o.upstream.port)}; }`,
    "  }",
    "}",
    "",
  ].join("\n");
  const confPath = path.join(o.dir, "conf", "nginx.conf");
  await writeFile(confPath, conf);
  const proc = spawnProcess(o.bin, ["-p", fwd(o.dir), "-c", fwd(confPath)], { stdio: "ignore" });
  // Ready when the port accepts a connection, not after a fixed wait.
  const until = Date.now() + 15_000;
  while (!(await accepts(port))) {
    if (proc.exitCode !== null || Date.now() > until) {
      if (proc.pid !== undefined) await killTree(proc.pid);
      throw new Error("nginx did not start listening");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    close: async () => {
      if (proc.pid !== undefined) await killTree(proc.pid);
    },
  };
};
