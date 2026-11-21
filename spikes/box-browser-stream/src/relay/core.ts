import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import {
  decodeMessage,
  encodeAck,
  encodeControl,
  encodeRecord,
  frameHeaderSchema,
  httpFramesMetaSchema,
  inputBatchSchema,
  type Control,
  type FrameHeader,
} from "../wire.ts";
import { serveViewer } from "./static.ts";

// "Core" for the spike: it accepts the sidecar's preview connection (a binary WebSocket, or the HTTP carrier's
// POSTs and long poll), relays frames to each member's streamed response, and passes input back. It acks a
// frame to the sidecar once every open stream has taken it (the response's write buffer drained), which is
// the back-pressure from the member's link to the box's browser.

const { values: args } = parseArgs({ options: { port: { type: "string", default: "8790" } } });

type View = {
  socket: WebSocket | null;
  readonly streams: Set<ServerResponse>;
  queued: Control[];
  down: { readonly response: ServerResponse; readonly timer: NodeJS.Timeout } | null;
};

const views = new Map<string, View>();
const stats = { framesIn: 0, bytesIn: 0, framesOut: 0, bytesOut: 0, ackWaitMs: 0, inputBatches: 0, inputEvents: 0, httpPosts: 0, polls: 0 };

const viewFor = (id: string): View => {
  let view = views.get(id);
  if (view === undefined) {
    view = { socket: null, streams: new Set(), queued: [], down: null };
    views.set(id, view);
  }
  return view;
};

const flushDown = (view: View) => {
  if (view.down === null || view.queued.length === 0) return;
  const { response, timer } = view.down;
  clearTimeout(timer);
  view.down = null;
  const controls = view.queued;
  view.queued = [];
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ controls }));
};

const sendControl = (view: View, control: Control) => {
  if (view.socket !== null) {
    view.socket.send(encodeControl(control));
    return;
  }
  view.queued.push(control);
  flushDown(view);
};

// Write one frame to every stream of the view; resolve when each has taken it.
const relayFrame = async (view: View, header: FrameHeader, jpeg: Buffer) => {
  stats.framesIn += 1;
  stats.bytesIn += jpeg.length;
  const record = encodeRecord(header, jpeg);
  const started = performance.now();
  const waits: Promise<void>[] = [];
  for (const stream of view.streams) {
    stats.framesOut += 1;
    stats.bytesOut += jpeg.length;
    if (!stream.write(record)) {
      waits.push(
        new Promise<void>((resolve) => {
          // Whichever comes first removes the other, or each held frame leaves a listener behind.
          const done = () => {
            stream.off("drain", done);
            stream.off("close", done);
            resolve();
          };
          stream.once("drain", done);
          stream.once("close", done);
        }),
      );
    }
  }
  await Promise.all(waits);
  stats.ackWaitMs += performance.now() - started;
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const reply = (response: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const viewIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

const server = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && (await serveViewer(url.pathname, response))) return;

      const panel = /^\/panel\/v1\/previews\/([^/]+)\/(stream|input)$/.exec(url.pathname);
      if (panel !== null) {
        const view = viewFor(viewIdSchema.parse(panel[1]));
        if (panel[2] === "stream" && request.method === "GET") {
          response.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
          response.flushHeaders();
          view.streams.add(response);
          sendControl(view, { kind: "viewers", count: view.streams.size });
          response.on("close", () => {
            view.streams.delete(response);
            sendControl(view, { kind: "viewers", count: view.streams.size });
          });
          return;
        }
        if (panel[2] === "input" && request.method === "POST") {
          const batch = inputBatchSchema.parse(JSON.parse((await readBody(request)).toString("utf8")));
          stats.inputBatches += 1;
          stats.inputEvents += batch.events.length;
          sendControl(view, { kind: "input", events: batch.events });
          reply(response, 204);
          return;
        }
      }

      if (url.pathname === "/runner/v1/preview/frames" && request.method === "POST") {
        stats.httpPosts += 1;
        const contentType = request.headers["content-type"] ?? "";
        const form = await new Response(new Uint8Array(await readBody(request)), { headers: { "content-type": contentType } }).formData();
        const metaText = form.get("meta");
        if (typeof metaText !== "string") throw new Error("no meta");
        const meta = httpFramesMetaSchema.parse(JSON.parse(metaText));
        const view = viewFor(viewIdSchema.parse(meta.viewId));
        for (const [index, header] of meta.frames.entries()) {
          const file = form.get(`f${String(index)}`);
          if (file === null || typeof file === "string") throw new Error("missing frame");
          await relayFrame(view, frameHeaderSchema.parse(header), Buffer.from(await file.arrayBuffer()));
        }
        reply(response, 204);
        return;
      }

      if (url.pathname === "/runner/v1/preview/down" && request.method === "GET") {
        stats.polls += 1;
        const view = viewFor(viewIdSchema.parse(url.searchParams.get("view")));
        if (view.down !== null) {
          clearTimeout(view.down.timer);
          reply(view.down.response, 200, { controls: [] });
        }
        const timer = setTimeout(() => {
          if (view.down?.response !== response) return;
          view.down = null;
          reply(response, 200, { controls: [] });
        }, 25_000);
        view.down = { response, timer };
        flushDown(view);
        return;
      }

      if (url.pathname === "/stats" && request.method === "GET") {
        reply(response, 200, stats);
        return;
      }
      if (url.pathname === "/stats/reset" && request.method === "POST") {
        for (const key of Object.keys(stats)) Reflect.set(stats, key, 0);
        reply(response, 200, { ok: true });
        return;
      }
      reply(response, 404, { error: "not found" });
    } catch (error) {
      reply(response, 400, { error: error instanceof Error ? error.message : "bad request" });
    }
  })();
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const id = viewIdSchema.safeParse(url.searchParams.get("view"));
  if (url.pathname !== "/runner/v1/preview" || !id.success) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    const view = viewFor(id.data);
    view.socket = ws;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => {
      if (!isBinary || !Buffer.isBuffer(data)) return;
      const message = decodeMessage(data);
      if (message.type !== "frame") return;
      void relayFrame(view, message.header, message.jpeg).then(() => {
        ws.send(encodeAck(message.header.seq));
      });
    });
    ws.on("close", () => {
      if (view.socket === ws) view.socket = null;
    });
    ws.send(encodeControl({ kind: "viewers", count: view.streams.size }));
  });
});

server.listen(Number(args.port), "127.0.0.1", () => {
  process.stdout.write(`core listening on ${args.port}\n`);
});
