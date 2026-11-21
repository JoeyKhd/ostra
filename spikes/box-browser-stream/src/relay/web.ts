import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { serveViewer } from "./static.ts";

// "The web app" for the spike: the panel's route handlers relay core's stream to the member's browser
// (GET /api/previews/<viewId>/stream) and post input on (POST /api/previews/<viewId>/input), as ADR 0068's
// browser view does. Route handlers can't upgrade to a WebSocket, so this is a streamed response.

const { values: args } = parseArgs({ options: { port: { type: "string", default: "8791" }, core: { type: "string", default: "http://127.0.0.1:8790" } } });

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && (await serveViewer(url.pathname, response))) return;
      const match = /^\/api\/previews\/([a-z0-9-]{1,64})\/(stream|input)$/.exec(url.pathname);
      if (match === null) {
        response.writeHead(404);
        response.end();
        return;
      }
      const target = new URL(`/panel/v1/previews/${match[1] ?? ""}/${match[2] ?? ""}`, args.core);
      if (match[2] === "stream") {
        const upstream = httpRequest(target, { method: "GET" });
        response.on("close", () => {
          upstream.destroy();
        });
        upstream.on("response", (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
          response.flushHeaders();
          pipeline(incoming, response).catch(() => undefined);
        });
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        upstream.end();
        return;
      }
      const body = await readBody(request);
      const upstream = await fetch(target, { method: "POST", body: new Uint8Array(body), headers: { "content-type": "application/json" } });
      response.writeHead(upstream.status);
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  })();
});

server.listen(Number(args.port), "127.0.0.1", () => {
  process.stdout.write(`web listening on ${args.port}\n`);
});
