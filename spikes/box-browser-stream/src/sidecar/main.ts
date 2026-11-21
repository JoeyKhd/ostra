import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";
import { openPage, type Page, type Viewport } from "../cdp/page.ts";
import { browserVersion, findBrowser, launchBrowser } from "../cdp/pipe.ts";
import { decodeMessage, encodeFrame, httpDownSchema, type Control } from "../wire.ts";
import { createInputQueue } from "./input.ts";
import { emptyStats, startScreencast, type CapMode, type FrameSink, type OutFrame, type ScreencastOptions } from "./screencast.ts";

// The "sidecar": it owns the box's browser over the DevTools pipe, keeps one shared page on the app, streams
// it to core over the preview connection (a binary WebSocket, or the HTTP carrier's POSTs and long poll), and
// applies the member's input. A small control API lets the harness configure and inspect it.

const { values: args } = parseArgs({
  options: {
    core: { type: "string", default: "http://127.0.0.1:8790" },
    view: { type: "string", default: "v1" },
    carrier: { type: "string", default: "ws" },
    app: { type: "string", default: "http://localhost:5173/" },
    control: { type: "string", default: "8792" },
    profiles: { type: "string" },
  },
});
const carrier = z.enum(["ws", "http"]).parse(args.carrier);
const coreUrl = args.core;
const viewId = args.view;

const configSchema = z.strictObject({
  width: z.number().int(),
  height: z.number().int(),
  mobile: z.boolean(),
  quality: z.number().int().min(1).max(100),
  fpsCap: z.number().min(0).max(60),
  capMode: z.enum(["ack", "drop"]),
  inflight: z.number().int().min(1).max(10),
  sendLastFrame: z.boolean(),
});
type Config = z.infer<typeof configSchema>;

let config: Config = {
  width: 1440,
  height: 900,
  mobile: false,
  quality: 60,
  fpsCap: carrier === "http" ? 2 : 15,
  capMode: "ack",
  inflight: carrier === "http" ? 1 : 3,
  sendLastFrame: true,
};

const executable = await findBrowser();
const cdp = await launchBrowser(args.profiles === undefined ? { executable } : { executable, profileRoot: args.profiles });
const version = await browserVersion(cdp);
const viewport = (): Viewport => ({ width: config.width, height: config.height, mobile: config.mobile });
const page = await openPage(cdp, viewport());
await page.navigate(args.app);

const stats = emptyStats();
const input = createInputQueue(() => page);
let viewers = 0;
let cast: { stop: () => Promise<void> } | null = null;
let castOp: Promise<void> = Promise.resolve();

const screencastOptions = (): ScreencastOptions => ({
  format: "jpeg",
  quality: config.quality,
  maxWidth: config.width,
  maxHeight: config.height,
  inflight: config.inflight,
  fpsCap: config.fpsCap,
  capMode: config.capMode,
  sendLastFrame: config.sendLastFrame,
});

// --- the carriers -------------------------------------------------------------------------------------------

let seq = 0;
const waitingAcks = new Map<number, () => void>();
let socket: WebSocket | null = null;

const wsSink: FrameSink = (frame: OutFrame) =>
  new Promise<void>((resolve) => {
    seq += 1;
    const current = socket;
    if (current?.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }
    waitingAcks.set(seq, resolve);
    current.send(encodeFrame({ seq, at: frame.at, w: frame.w, h: frame.h }, frame.data));
  });

const httpSink: FrameSink = async (frame: OutFrame) => {
  seq += 1;
  const form = new FormData();
  form.set("meta", JSON.stringify({ viewId, frames: [{ seq, at: frame.at, w: frame.w, h: frame.h }] }));
  form.set("f0", new Blob([new Uint8Array(frame.data)], { type: "image/jpeg" }), "f0.jpg");
  try {
    await fetch(`${coreUrl}/runner/v1/preview/frames`, { method: "POST", body: form });
  } catch {
    // core is gone; the harness is ending
  }
};

const restartCast = () => {
  castOp = castOp.then(async () => {
    if (cast !== null) {
      await cast.stop();
      cast = null;
    }
    if (viewers > 0) cast = await startScreencast(page, screencastOptions(), carrier === "ws" ? wsSink : httpSink, stats);
  });
  return castOp;
};

const handleControl = async (control: Control) => {
  switch (control.kind) {
    case "viewers": {
      const before = viewers;
      viewers = control.count;
      if ((before === 0) !== (viewers === 0)) await restartCast();
      return;
    }
    case "viewport":
      config = { ...config, width: control.width, height: control.height, mobile: control.mobile };
      await page.setViewport(viewport());
      await restartCast();
      return;
    case "navigate":
      await page.navigate(control.url);
      return;
    case "reload":
      await page.send("Page.reload");
      return;
    case "input":
      input.push(control.events);
      return;
    default:
      control satisfies never;
  }
};

if (carrier === "ws") {
  const wsUrl = `${coreUrl.replace(/^http/, "ws")}/runner/v1/preview?view=${encodeURIComponent(viewId)}`;
  socket = new WebSocket(wsUrl);
  socket.binaryType = "nodebuffer";
  socket.on("message", (data, isBinary) => {
    if (!isBinary || !Buffer.isBuffer(data)) return;
    const message = decodeMessage(data);
    if (message.type === "ack") {
      const resolve = waitingAcks.get(message.seq);
      waitingAcks.delete(message.seq);
      resolve?.();
    } else if (message.type === "control") {
      void handleControl(message.control);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket?.once("open", () => {
      resolve();
    });
    socket?.once("error", reject);
  });
} else {
  void (async () => {
    for (;;) {
      try {
        const response = await fetch(`${coreUrl}/runner/v1/preview/down?view=${encodeURIComponent(viewId)}`, { signal: AbortSignal.timeout(30_000) });
        const body = httpDownSchema.parse(await response.json());
        for (const control of body.controls) await handleControl(control);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })();
}

// --- screenshots and recordings, each in a page of its own -----------------------------------------------

const waitForApp = async (target: Page) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await target.evaluate("document.querySelector('#api')?.className ?? 'none'");
    if (state === "ok" || state === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
};

const screenshotSchema = z.strictObject({ width: z.number().int(), height: z.number().int(), mobile: z.boolean(), save: z.string().optional() });

const takeScreenshot = async (body: z.infer<typeof screenshotSchema>) => {
  const started = performance.now();
  const own = await openPage(cdp, { width: body.width, height: body.height, mobile: body.mobile });
  try {
    await own.navigate(args.app);
    await waitForApp(own);
    const capturedAt = performance.now();
    const png = await own.screenshot("png");
    const captureMs = performance.now() - capturedAt;
    if (body.save !== undefined) await writeFile(body.save, png);
    return { bytes: png.length, captureMs: Math.round(captureMs), totalMs: Math.round(performance.now() - started) };
  } finally {
    await own.close();
  }
};

const recordSchema = z.strictObject({
  seconds: z.number().min(1).max(30),
  fps: z.number().min(1).max(30),
  format: z.enum(["jpeg", "png"]),
  quality: z.number().int().min(1).max(100),
  steps: z.enum(["scroll", "interact"]),
  capMode: z.enum(["ack", "drop"]),
  width: z.number().int(),
  height: z.number().int(),
});

const record = async (body: z.infer<typeof recordSchema>) => {
  const own = await openPage(cdp, { width: body.width, height: body.height, mobile: false });
  const frames: { at: number; bytes: number }[] = [];
  let frameBytes = 0;
  try {
    await own.navigate(args.app);
    await waitForApp(own);
    const reelStats = emptyStats();
    const capMode: CapMode = body.capMode;
    const recording = await startScreencast(
      own,
      { format: body.format, quality: body.quality, maxWidth: body.width, maxHeight: body.height, inflight: 1, fpsCap: body.fps, capMode, sendLastFrame: true },
      (frame) => {
        frames.push({ at: frame.at, bytes: frame.data.length });
        frameBytes += frame.data.length;
        return Promise.resolve();
      },
      reelStats,
    );
    const started = Date.now();
    const box = z
      .strictObject({ x: z.number(), y: z.number() })
      .parse(await own.evaluate("(() => { const r = document.querySelector('#counter').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"));
    const field = z
      .strictObject({ x: z.number(), y: z.number() })
      .parse(await own.evaluate("(() => { const r = document.querySelector('#field').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })()"));
    const click = async (x: number, y: number) => {
      await own.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await own.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    };
    const text = "hello ostra, this is a recording ";
    let typed = 0;
    let clicks = 0;
    while (Date.now() - started < body.seconds * 1000) {
      const elapsed = Date.now() - started;
      if (body.steps === "scroll") {
        await own.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: body.width / 2, y: body.height / 2, deltaX: 0, deltaY: 80 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (clicks < 3 && elapsed > 500 + clicks * 1000) {
        await click(box.x, box.y);
        clicks += 1;
      } else if (clicks === 3 && elapsed > 3500 && elapsed < 6500) {
        if (typed === 0) await click(field.x, field.y);
        const char = text[typed % text.length] ?? " ";
        await own.send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char, unmodifiedText: char });
        await own.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
        typed += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    await recording.stop();
    const index = JSON.stringify({ frames: frames.map((frame) => ({ t: frame.at - started, bytes: frame.bytes })), steps: body.steps });
    return {
      frames: frames.length,
      frameBytes,
      indexBytes: Buffer.byteLength(index),
      reelBytes: frameBytes + Buffer.byteLength(index),
      produced: reelStats.produced,
      dropped: reelStats.dropped,
      clicks,
      typed,
    };
  } finally {
    await own.close();
  }
};

// --- the control API ---------------------------------------------------------------------------------------

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const reply = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const control = createServer((request, response) => {
  void (async () => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      switch (`${request.method ?? "GET"} ${url.pathname}`) {
        case "GET /info":
          reply(response, 200, { browserPid: cdp.pid, executable: cdp.executable, product: version.product, userAgent: version.userAgent, protocol: version.protocolVersion, sidecarPid: process.pid, carrier });
          return;
        case "GET /stats":
          reply(response, 200, { ...stats, input: input.counts(), pipe: cdp.stats, viewers, config });
          return;
        case "POST /stats/reset":
          Object.assign(stats, emptyStats());
          reply(response, 200, { ok: true });
          return;
        case "POST /config":
          config = configSchema.parse(await readJson(request));
          await page.setViewport(viewport());
          await restartCast();
          reply(response, 200, { ok: true, config });
          return;
        case "POST /eval": {
          const body = z.strictObject({ expression: z.string() }).parse(await readJson(request));
          reply(response, 200, { value: await page.evaluate(body.expression) });
          return;
        }
        case "POST /navigate": {
          const body = z.strictObject({ url: z.string() }).parse(await readJson(request));
          await page.navigate(body.url);
          reply(response, 200, { ok: true });
          return;
        }
        case "POST /screenshot":
          reply(response, 200, await takeScreenshot(screenshotSchema.parse(await readJson(request))));
          return;
        case "POST /record":
          reply(response, 200, await record(recordSchema.parse(await readJson(request))));
          return;
        case "POST /quit":
          reply(response, 200, { ok: true });
          await shutdown();
          return;
        default:
          reply(response, 404, { error: "not found" });
      }
    } catch (error) {
      reply(response, 500, { error: error instanceof Error ? error.message : "failed" });
    }
  })();
});

const shutdown = async () => {
  if (cast !== null) await cast.stop().catch(() => undefined);
  socket?.close();
  control.close();
  await cdp.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

control.listen(Number(args.control), "127.0.0.1", () => {
  process.stdout.write(`sidecar ready on ${args.control} (${carrier}, ${version.product})\n`);
});
