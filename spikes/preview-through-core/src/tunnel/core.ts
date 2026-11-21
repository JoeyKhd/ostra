import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { connect as h2connect, createServer as createH2Server, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { WebSocketServer, createWebSocketStream } from "ws";
import { z } from "zod";
import { firstValue, forwardableHeaders, pipeFailed, splice, targetPortHeader, trace, websocketAccept } from "./headers.ts";

// "Core" for the spike, shaped like ADR 0068's:
// - the box's preview connection at /runner/v1/preview: a WebSocket whose bytes are an HTTP/2 connection, with
//   core as the client;
// - preview hosts <port>-<previewId>.<domain>: each request a request on that connection, each browser
//   WebSocket an RFC 8441 extended CONNECT, behind a cookie set by a one-time-code handshake;
// - the CLI's tunnel at /cli/v1/tunnel: a WebSocket whose bytes are an HTTP/2 connection with the CLI as the
//   client; each of its CONNECT streams is bridged to a CONNECT stream on the box's connection.
// Preview p1 rewrites Host and Origin to localhost:<port> (the default); p2 has the rewrite off and sends
// X-Forwarded-Host and X-Forwarded-Proto instead.

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "8800" },
    "tls-port": { type: "string", default: "8443" },
    cert: { type: "string" },
    key: { type: "string" },
    panel: { type: "string", default: "http://localhost:3410,https://localhost:3443" },
  },
});

const panelOrigins = args.panel.split(",");
const previews = new Map([
  ["p1", { view: "v1", hostRewrite: true }],
  ["p2", { view: "v1", hostRewrite: false }],
]);
const cookieName = "__Host-ostra-preview";

type Code = { readonly port: number; readonly previewId: string; readonly layout: "cross-site" | "same-site"; readonly expiresAt: number };
const codes = new Map<string, Code>();
const sessions = new Map<string, { readonly port: number; readonly previewId: string }>();
const tickets = new Map<string, { readonly port: number; readonly expiresAt: number }>();
const boxes = new Map<string, ClientHttp2Session>();
// What the browser said about each handshake's request: whether it was cross-site, and in a frame.
const enterLog: { site: string; dest: string; agent: string; ok: boolean }[] = [];
const stats = { previewRequests: 0, previewUpgrades: 0, cliStreams: 0, refusedNoCookie: 0, refusedOrigin: 0, codesUsed: 0, codesRefused: 0, bytesToBrowser: 0 };

const token = () => randomBytes(24).toString("base64url");

// --- the box's preview connection -------------------------------------------------------------------------------

const openBoxSession = (view: string, duplex: Duplex) => {
  const session = h2connect("http://box.invalid", { createConnection: () => duplex });
  session.on("error", pipeFailed("box session"));
  session.on("goaway", (code) => {
    trace(`box session goaway ${String(code)}`);
  });
  session.once("remoteSettings", () => {
    boxes.set(view, session);
  });
  session.on("close", () => {
    trace("box session closed");
    if (boxes.get(view) === session) boxes.delete(view);
  });
};

// --- preview hosts -----------------------------------------------------------------------------------------------

type PreviewHost = { readonly port: number; readonly previewId: string; readonly host: string };
const parsePreviewHost = (host: string | undefined): PreviewHost | null => {
  if (host === undefined) return null;
  const match = /^(\d{4,5})-([a-z0-9]+)\./.exec(host);
  if (match === null) return null;
  const port = Number(match[1]);
  const previewId = match[2] ?? "";
  return previews.has(previewId) ? { port, previewId, host } : null;
};

const cookieValue = (header: string | undefined): string | undefined => {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === cookieName) return rest.join("=");
  }
  return undefined;
};
const withoutOurCookie = (header: string | undefined): string | undefined => {
  const kept = (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith(`${cookieName}=`));
  return kept.length === 0 ? undefined : kept.join("; ");
};
const hasSession = (request: IncomingMessage, preview: PreviewHost) => {
  const value = cookieValue(firstValue(request.headers.cookie));
  if (value === undefined) return false;
  const session = sessions.get(value);
  return session?.port === preview.port && session.previewId === preview.previewId;
};

const requestHeadersFor = (request: IncomingMessage, preview: PreviewHost, secure: boolean): OutgoingHttpHeaders => {
  const rewrite = previews.get(preview.previewId)?.hostRewrite ?? true;
  const headers = forwardableHeaders(request.headers, (name) => name.startsWith("x-forwarded-"));
  const cookie = withoutOurCookie(firstValue(request.headers.cookie));
  if (cookie === undefined) delete headers.cookie;
  else headers.cookie = cookie;
  headers[targetPortHeader] = String(preview.port);
  const origin = firstValue(request.headers.origin);
  const ownOrigin = `${secure ? "https" : "http"}://${preview.host}`;
  if (rewrite) {
    if (origin === ownOrigin) headers.origin = `http://localhost:${String(preview.port)}`;
  } else {
    headers["x-forwarded-host"] = preview.host;
    headers["x-forwarded-proto"] = secure ? "https" : "http";
  }
  return headers;
};

const responseHeadersFor = (headers: IncomingHttpHeaders, preview: PreviewHost, secure: boolean): OutgoingHttpHeaders => {
  const out = forwardableHeaders(headers);
  delete out[":status"];
  const location = firstValue(headers.location);
  const local = `http://localhost:${String(preview.port)}`;
  if (location?.startsWith(local) === true) out.location = `${secure ? "https" : "http"}://${preview.host}${location.slice(local.length)}`;
  delete out["x-frame-options"];
  const csp = firstValue(headers["content-security-policy"]);
  const ancestors = `frame-ancestors ${panelOrigins.join(" ")}`;
  out["content-security-policy"] =
    csp === undefined
      ? ancestors
      : [
          ...csp
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part.length > 0 && !part.startsWith("frame-ancestors")),
          ancestors,
        ].join("; ");
  return out;
};

const page = (response: ServerResponse, status: number, html: string) => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
};

const handlePreview = (request: IncomingMessage, response: ServerResponse, preview: PreviewHost, secure: boolean) => {
  const url = new URL(request.url ?? "/", "http://preview");
  if (url.pathname === "/.ostra/enter") {
    const code = url.searchParams.get("code") ?? "";
    const entry = codes.get(code);
    codes.delete(code);
    if (entry === undefined || entry.expiresAt < Date.now() || entry.port !== preview.port || entry.previewId !== preview.previewId) {
      stats.codesRefused += 1;
      page(response, 403, "<p id=bad-code>this code is used, expired or for another preview</p>");
      return;
    }
    stats.codesUsed += 1;
    const agent = firstValue(request.headers["user-agent"]) ?? "";
    enterLog.push({
      site: firstValue(request.headers["sec-fetch-site"]) ?? "none",
      dest: firstValue(request.headers["sec-fetch-dest"]) ?? "none",
      agent: agent.includes("Firefox") ? "firefox" : agent.includes("Edg/") ? "edge" : agent.includes("Chrome") ? "chrome" : "other",
      ok: true,
    });
    const value = token();
    sessions.set(value, { port: preview.port, previewId: preview.previewId });
    const attributes = entry.layout === "cross-site" ? "SameSite=None; Partitioned" : "SameSite=Lax";
    const next = url.searchParams.get("next") ?? "/";
    response.writeHead(302, {
      "set-cookie": `${cookieName}=${value}; Path=/; Secure; HttpOnly; ${attributes}; Max-Age=43200`,
      location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
      "cache-control": "no-store",
    });
    response.end();
    return;
  }
  if (!hasSession(request, preview)) {
    stats.refusedNoCookie += 1;
    page(response, 401, "<p id=no-cookie>no preview cookie</p>");
    return;
  }
  if (url.pathname === "/.ostra/ok") {
    page(response, 200, "<p id=ok>ok</p>");
    return;
  }
  const box = boxes.get(previews.get(preview.previewId)?.view ?? "");
  if (box === undefined) {
    page(response, 503, "<p id=no-box>the box isn't connected</p>");
    return;
  }
  stats.previewRequests += 1;
  const rewrite = previews.get(preview.previewId)?.hostRewrite ?? true;
  const stream: ClientHttp2Stream = box.request({
    ...requestHeadersFor(request, preview, secure),
    ":method": request.method ?? "GET",
    ":path": request.url ?? "/",
    ":scheme": "http",
    ":authority": rewrite ? `localhost:${String(preview.port)}` : preview.host,
  });
  stream.on("error", () => {
    if (!response.headersSent) page(response, 502, "<p>bad gateway</p>");
    else response.destroy();
  });
  stream.on("response", (headers) => {
    response.writeHead(headers[":status"] ?? 502, responseHeadersFor(headers, preview, secure));
    stream.on("data", (chunk: Buffer) => {
      stats.bytesToBrowser += chunk.length;
    });
    pipeline(stream, response).catch(() => undefined);
  });
  pipeline(request, stream).catch(() => undefined);
};

const handlePreviewUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer, preview: PreviewHost, secure: boolean) => {
  const fail = (status: number, reason: string) => {
    socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  };
  if (!hasSession(request, preview)) {
    stats.refusedNoCookie += 1;
    fail(401, "Unauthorized");
    return;
  }
  const origin = firstValue(request.headers.origin);
  if (origin !== `${secure ? "https" : "http"}://${preview.host}`) {
    stats.refusedOrigin += 1;
    fail(403, "Forbidden");
    return;
  }
  const box = boxes.get(previews.get(preview.previewId)?.view ?? "");
  const key = firstValue(request.headers["sec-websocket-key"]);
  if (box === undefined || key === undefined) {
    fail(503, "Unavailable");
    return;
  }
  stats.previewUpgrades += 1;
  const rewrite = previews.get(preview.previewId)?.hostRewrite ?? true;
  const headers = requestHeadersFor(request, preview, secure);
  delete headers["sec-websocket-key"];
  const stream = box.request({
    ...headers,
    ":method": "CONNECT",
    ":protocol": "websocket",
    ":scheme": "http",
    ":path": request.url ?? "/",
    ":authority": rewrite ? `localhost:${String(preview.port)}` : preview.host,
  });
  stream.on("error", () => {
    socket.destroy();
  });
  stream.on("response", (reply) => {
    const status = reply[":status"] ?? 502;
    if (status !== 200) {
      fail(status, "Refused");
      stream.close();
      return;
    }
    const lines = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${websocketAccept(key)}`];
    const protocol = firstValue(reply["sec-websocket-protocol"]);
    const extensions = firstValue(reply["sec-websocket-extensions"]);
    if (protocol !== undefined) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    if (extensions !== undefined) lines.push(`Sec-WebSocket-Extensions: ${extensions}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) stream.write(head);
    splice(stream, socket);
  });
};

// --- the CLI's tunnel --------------------------------------------------------------------------------------------

const cliServer = createH2Server();
const cliPorts = new WeakMap<object, number>();
cliServer.on("session", (session) => {
  session.on("error", pipeFailed("core cli session"));
  session.on("goaway", (code) => {
    trace(`core cli session goaway ${String(code)}`);
  });
});
cliServer.on("stream", (stream, headers) => {
  stream.on("error", () => undefined);
  const allowedPort = cliPorts.get(stream.session ?? {});
  const authority = firstValue(headers[":authority"]) ?? "";
  const port = Number(authority.split(":").at(-1));
  const box = boxes.get("v1");
  if (firstValue(headers[":method"]) !== "CONNECT" || port !== allowedPort || box === undefined) {
    stream.respond({ ":status": 403 });
    stream.end();
    return;
  }
  stats.cliStreams += 1;
  const upstream = box.request({ ":method": "CONNECT", ":authority": `localhost:${String(port)}` });
  upstream.on("error", () => {
    stream.destroy();
  });
  upstream.on("response", (reply) => {
    const status = reply[":status"] ?? 502;
    stream.respond({ ":status": status });
    if (status !== 200) {
      stream.end();
      return;
    }
    let fromBox = 0;
    upstream.on("data", (chunk: Buffer) => {
      fromBox += chunk.length;
    });
    upstream.on("close", () => {
      trace(`core cli ${String(stream.id)}: box stream closed (rst ${String(upstream.rstCode)}) after ${String(fromBox)} bytes`);
    });
    stream.on("close", () => {
      trace(`core cli ${String(stream.id)}: cli stream closed (rst ${String(stream.rstCode)}) after ${String(fromBox)} bytes from the box`);
    });
    splice(upstream, stream);
  });
});

// --- control, standing in for the panel's tRPC and the CLI's HTTP API ---------------------------------------------

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const handleControl = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://core");
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/control/code" && request.method === "POST") {
    const body = z.strictObject({ port: z.number().int(), previewId: z.string(), layout: z.enum(["cross-site", "same-site"]) }).parse(await readJson(request));
    const code = token();
    codes.set(code, { ...body, expiresAt: Date.now() + 60_000 });
    json(200, { code });
    return;
  }
  if (url.pathname === "/control/ticket" && request.method === "POST") {
    const body = z.strictObject({ port: z.number().int() }).parse(await readJson(request));
    const ticket = token();
    tickets.set(ticket, { port: body.port, expiresAt: Date.now() + 60_000 });
    json(200, { ticket });
    return;
  }
  if (url.pathname === "/control/stats") {
    json(200, { ...stats, boxes: boxes.size, enterLog });
    return;
  }
  if (url.pathname === "/control/sidecar-stats") {
    const box = boxes.get("v1");
    if (box === undefined) {
      json(503, {});
      return;
    }
    const stream = box.request({ ":method": "GET", ":path": "/", ":authority": "sidecar.stats" });
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      json(200, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    });
    stream.end();
    return;
  }
  json(404, {});
};

// --- the listeners -----------------------------------------------------------------------------------------------

const sockets = new WebSocketServer({ noServer: true });

const onRequest = (secure: boolean) => (request: IncomingMessage, response: ServerResponse) => {
  const preview = parsePreviewHost(firstValue(request.headers.host));
  if (preview !== null) {
    handlePreview(request, response, preview, secure);
    return;
  }
  handleControl(request, response).catch((error: unknown) => {
    response.writeHead(400);
    response.end(error instanceof Error ? error.message : "bad request");
  });
};

const onUpgrade = (secure: boolean) => (request: IncomingMessage, socket: Duplex, head: Buffer) => {
  socket.on("error", () => undefined);
  const preview = parsePreviewHost(firstValue(request.headers.host));
  if (preview !== null) {
    handlePreviewUpgrade(request, socket, head, preview, secure);
    return;
  }
  const url = new URL(request.url ?? "/", "http://core");
  if (url.pathname === "/runner/v1/preview") {
    const view = url.searchParams.get("view") ?? "";
    sockets.handleUpgrade(request, socket, head, (ws) => {
      openBoxSession(view, createWebSocketStream(ws));
    });
    return;
  }
  if (url.pathname === "/cli/v1/tunnel") {
    const ticket = url.searchParams.get("ticket") ?? "";
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (entry === undefined || entry.expiresAt < Date.now()) {
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const duplex = createWebSocketStream(ws);
      duplex.on("error", () => undefined);
      cliServer.once("session", (session) => {
        cliPorts.set(session, entry.port);
      });
      cliServer.emit("connection", duplex);
    });
    return;
  }
  socket.destroy();
};

const plain = createHttpServer(onRequest(false));
plain.on("upgrade", onUpgrade(false));
plain.listen(Number(args.port), "127.0.0.1", () => {
  process.stdout.write(`core listening on ${args.port}\n`);
});

if (args.cert !== undefined && args.key !== undefined) {
  const tls = createHttpsServer({ cert: await readFile(args.cert), key: await readFile(args.key) }, onRequest(true));
  tls.on("upgrade", onUpgrade(true));
  tls.listen(Number(args["tls-port"]), "127.0.0.1", () => {
    process.stdout.write(`core listening on ${args["tls-port"]} (tls)\n`);
  });
}
