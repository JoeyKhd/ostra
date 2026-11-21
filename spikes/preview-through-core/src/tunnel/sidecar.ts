import { randomBytes } from "node:crypto";
import { request as httpRequest, Agent, type IncomingMessage } from "node:http";
import { createServer as createH2Server, type IncomingHttpHeaders, type ServerHttp2Stream, constants } from "node:http2";
import { connect, type Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { WebSocket, createWebSocketStream } from "ws";
import { firstValue, forwardableHeaders, splice, targetPortHeader, trace } from "./headers.ts";

// The "sidecar": it dials core's preview connection (wss://<core>/runner/v1/preview?view=…) in tunnel mode and
// serves HTTP/2 on it, from Node's own http2 over the WebSocket's duplex stream, with core as the client.
// - a plain request becomes an HTTP/1.1 request to the box's port;
// - an extended CONNECT with :protocol websocket (RFC 8441) becomes an HTTP/1.1 upgrade to the port, then raw bytes;
// - a plain CONNECT becomes a raw TCP connection to the port (ostra preview's local forward).
// It reaches only the ports it was told are the task's, and never anything below 1024.

const { values: args } = parseArgs({
  options: {
    core: { type: "string", default: "ws://127.0.0.1:8800" },
    view: { type: "string", default: "v1" },
    allow: { type: "string", default: "5173,3002,8080,3001" },
    forwarder: { type: "string" },
    "forwarder-from": { type: "string", default: "127.0.0.2" },
    "forwarder-offset": { type: "string", default: "10000" },
  },
});

const allowed = new Set(args.allow.split(",").map(Number));
const stats = { requests: 0, websockets: 0, connects: 0, refused: 0, errors: 0 };

// How the sidecar reaches the app: on docker through the init's forwarder on the box network (from the
// sidecar's own address only), elsewhere at localhost, trying IPv4 and IPv6 (a dev server bound to "localhost"
// may be on ::1 only).
const dial = (port: number): Socket => {
  if (args.forwarder !== undefined) return connect({ host: args.forwarder, port: port + Number(args["forwarder-offset"]), localAddress: args["forwarder-from"] });
  return connect({ host: "localhost", port, autoSelectFamily: true });
};

const agents = new Map<number, Agent>();
const agentFor = (port: number): Agent => {
  let agent = agents.get(port);
  if (agent === undefined) {
    agent = new Agent({ keepAlive: true, maxSockets: 64 });
    agents.set(port, agent);
  }
  return agent;
};

const portOf = (headers: IncomingHttpHeaders): number | null => {
  const explicit = firstValue(headers[targetPortHeader]);
  const authority = firstValue(headers[":authority"]) ?? "";
  const port = Number(explicit ?? authority.split(":").at(-1));
  return Number.isInteger(port) && port >= 1024 && allowed.has(port) ? port : null;
};

const responseHeaders = (incoming: IncomingMessage) => {
  const headers = forwardableHeaders(incoming.headers);
  return { ...headers, [constants.HTTP2_HEADER_STATUS]: incoming.statusCode ?? 502 };
};

const refuse = (stream: ServerHttp2Stream, status: number) => {
  stats.refused += 1;
  if (!stream.headersSent) stream.respond({ ":status": status });
  stream.end();
};

const handleRequest = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, port: number) => {
  stats.requests += 1;
  const outHeaders = forwardableHeaders(headers, (name) => name === targetPortHeader);
  outHeaders.host = firstValue(headers[":authority"]) ?? `localhost:${String(port)}`;
  const options = {
    method: firstValue(headers[":method"]) ?? "GET",
    path: firstValue(headers[":path"]) ?? "/",
    headers: outHeaders,
  };
  const upstream =
    args.forwarder === undefined
      ? httpRequest({ ...options, host: "localhost", port, agent: agentFor(port) })
      : httpRequest({ ...options, createConnection: () => dial(port) });
  upstream.on("response", (incoming) => {
    if (stream.destroyed) {
      incoming.destroy();
      return;
    }
    stream.respond(responseHeaders(incoming));
    pipeline(incoming, stream).catch(() => undefined);
  });
  upstream.on("error", () => {
    stats.errors += 1;
    refuse(stream, 502);
  });
  stream.on("close", () => {
    upstream.destroy();
  });
  pipeline(stream, upstream).catch(() => undefined);
};

const handleWebSocket = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders, port: number) => {
  stats.websockets += 1;
  const outHeaders = forwardableHeaders(headers, (name) => name === targetPortHeader);
  outHeaders.host = firstValue(headers[":authority"]) ?? `localhost:${String(port)}`;
  outHeaders.connection = "Upgrade";
  outHeaders.upgrade = "websocket";
  outHeaders["sec-websocket-key"] = randomBytes(16).toString("base64");
  outHeaders["sec-websocket-version"] = "13";
  trace(`sidecar websocket ${String(stream.id)} to ${String(port)}: host ${outHeaders.host}, origin ${JSON.stringify(outHeaders.origin ?? null)}`);
  const upstream = httpRequest({ method: "GET", path: firstValue(headers[":path"]) ?? "/", headers: outHeaders, createConnection: () => dial(port) });
  upstream.on("upgrade", (incoming, socket, head) => {
    const reply: Record<string, string | number> = { ":status": 200 };
    const protocol = firstValue(incoming.headers["sec-websocket-protocol"]);
    const extensions = firstValue(incoming.headers["sec-websocket-extensions"]);
    if (protocol !== undefined) reply["sec-websocket-protocol"] = protocol;
    if (extensions !== undefined) reply["sec-websocket-extensions"] = extensions;
    stream.respond(reply);
    if (head.length > 0) stream.write(head);
    splice(socket, stream);
  });
  upstream.on("response", (incoming) => {
    stream.respond(responseHeaders(incoming));
    pipeline(incoming, stream).catch(() => undefined);
  });
  upstream.on("error", () => {
    stats.errors += 1;
    refuse(stream, 502);
  });
  upstream.end();
};

const handleConnect = (stream: ServerHttp2Stream, port: number) => {
  stats.connects += 1;
  const socket = dial(port);
  socket.once("connect", () => {
    stream.respond({ ":status": 200 });
    let fromApp = 0;
    socket.on("data", (chunk: Buffer) => {
      fromApp += chunk.length;
    });
    socket.on("close", () => {
      trace(`sidecar connect ${String(stream.id)}: app socket closed after ${String(fromApp)} bytes`);
    });
    stream.on("close", () => {
      trace(`sidecar connect ${String(stream.id)}: h2 stream closed (rst ${String(stream.rstCode)}) after ${String(fromApp)} bytes from the app`);
    });
    splice(socket, stream);
  });
  socket.once("error", () => {
    stats.errors += 1;
    refuse(stream, 502);
  });
};

const server = createH2Server({ settings: { enableConnectProtocol: true } });
server.on("stream", (stream, headers) => {
  stream.on("error", () => undefined);
  if (firstValue(headers[":authority"]) === "sidecar.stats") {
    stream.respond({ ":status": 200, "content-type": "application/json" });
    stream.end(JSON.stringify(stats));
    return;
  }
  const port = portOf(headers);
  if (port === null) {
    refuse(stream, 403);
    return;
  }
  const method = firstValue(headers[":method"]);
  if (method === "CONNECT") {
    if (firstValue(headers[":protocol"]) === "websocket") handleWebSocket(stream, headers, port);
    else handleConnect(stream, port);
    return;
  }
  handleRequest(stream, headers, port);
});
server.on("sessionError", (error) => {
  process.stderr.write(`sidecar session error: ${error.message}\n`);
});

const socket = new WebSocket(`${args.core}/runner/v1/preview?view=${encodeURIComponent(args.view)}&mode=tunnel`);
socket.on("open", () => {
  const duplex = createWebSocketStream(socket);
  duplex.on("error", (error) => {
    process.stderr.write(`sidecar duplex error: ${error.message}\n`);
  });
  server.emit("connection", duplex);
  process.stdout.write(`sidecar tunnel open (${args.forwarder === undefined ? "localhost" : `forwarder ${args.forwarder}`})\n`);
});
socket.on("close", (code, reason) => {
  process.stdout.write(`sidecar tunnel closed (${String(code)} ${reason.toString("utf8")})\n`);
  process.exit(0);
});
socket.on("error", (error) => {
  process.stderr.write(`sidecar: ${error.message}\n`);
  process.exit(1);
});
