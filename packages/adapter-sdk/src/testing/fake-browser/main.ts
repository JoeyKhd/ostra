// The fake box browser (milestone 8, ticket 03; spec section 9): a Node program that speaks enough
// of the DevTools protocol over `--remote-debugging-pipe` for the executor suite and the runner's
// unit tests that need no pixels. Chromium's way: commands arrive on fd 3 and replies and events
// leave on fd 4, each message one JSON text ended by a NUL byte. It opens no port.
//
// It answers `Browser.getVersion` and `Browser.close`; `Target.createTarget`, `attachToTarget`
// (flattened sessions), `closeTarget` and `getTargets`; `Page.navigate`, which really fetches the
// page over HTTP (so a page "loads at the app's localhost" only when the app answers), then sends
// `Page.loadEventFired`; `Runtime.evaluate` of `document.title`, `location.href` and the last
// load's navigation type (`performance.getEntriesByType("navigation")`: `navigate` or `reload`);
// `Page.captureScreenshot` as a real PNG of the viewport's size (or of its clip); `Page.getLayoutMetrics`
// as a page twice the viewport's height (ticket 13's full page); `Page.startScreencast` with
// `maxFramesInFlight`, `maxWidth` and `maxHeight`, and `Page.screencastFrameAck`, its frames
// shaped as JPEGs (SOI to EOI, a frame header with the picture's size, no pixels); and
// `Input.*`, counted. The rest of the domains' enables and settings answer `{}`; an
// unknown method gets DevTools' error. Like a browser, it takes its flags, writes nothing to its
// profile folder beyond a marker, and exits when its pipe closes.

import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { connect, Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";

const deflateAsync = promisify(deflate);

export const FAKE_BROWSER_PRODUCT = "OstraFakeBrowser/1.0.0";

type Viewport = { width: number; height: number };

type Page = {
  readonly targetId: string;
  url: string;
  title: string;
  viewport: Viewport;
  /** How the page last loaded, as its navigation timing's `type` says it. */
  loaded: "navigate" | "reload";
  inputs: number;
  screencast: Screencast | null;
};

/** A page's screencast: its frames in flight and their cap, and the largest picture it sends (`maxWidth`, `maxHeight`). */
type Screencast = { inFlight: number; max: number; timer: NodeJS.Timeout | undefined; frame: number; readonly maxWidth: number | null; readonly maxHeight: number | null };

const pages = new Map<string, Page>();
const sessions = new Map<string, Page>();
let counter = 0;

const arg = (name: string): string | undefined => process.argv.find((each) => each.startsWith(`--${name}=`))?.slice(name.length + 3);

const output = new Socket({ fd: 4, readable: false, writable: true });
const input = new Socket({ fd: 3, readable: true, writable: false });

const send = (message: Record<string, unknown>): void => {
  output.write(`${JSON.stringify(message)}\0`);
};

const event = (method: string, params: Record<string, unknown>, sessionId?: string): void => {
  send(sessionId === undefined ? { method, params } : { method, params, sessionId });
};

/** A real PNG of one colour at the viewport's size: a picture's checks read its header and size. */
const png = async (viewport: Viewport): Promise<Buffer> => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(viewport.width, 0);
  header.writeUInt32BE(viewport.height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const row = Buffer.alloc(1 + viewport.width * 3, 0xee);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: viewport.height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", await deflateAsync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

/** A frame's picture, as Chromium's: the page's viewport, scaled down (never up), keeping its shape, to fit the screencast's `maxWidth` and `maxHeight`. */
const castSize = (page: Page, cast: Screencast): Viewport => {
  const scale = Math.min(1, (cast.maxWidth ?? Number.POSITIVE_INFINITY) / page.viewport.width, (cast.maxHeight ?? Number.POSITIVE_INFINITY) / page.viewport.height);
  return { width: Math.max(1, Math.floor(page.viewport.width * scale)), height: Math.max(1, Math.floor(page.viewport.height * scale)) };
};

/**
 * A frame shaped as a JPEG with no pixels, for the tests that count frames and read their size:
 * its start marker, a baseline frame header (SOF0) naming the picture's size, a comment saying
 * which frame of which page it is and how many input events reached the page, and its end marker.
 */
const frame = (page: Page, n: number, size: Viewport): Buffer => {
  const header = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  header.writeUInt16BE(size.height, 5);
  header.writeUInt16BE(size.width, 7);
  const text = Buffer.from(`fake frame ${String(n)} of ${page.url} after ${String(page.inputs)} inputs`);
  const comment = Buffer.from([0xff, 0xfe, 0, 0]);
  comment.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, comment, text, Buffer.from([0xff, 0xd9])]);
};

/** Fetches a page over HTTP, at `localhost` over IPv6 and IPv4, as a browser would. */
const fetchPage = (url: string): Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly error: string }> =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, error: "net::ERR_INVALID_URL" });
      return;
    }
    if (target.protocol !== "http:") {
      resolve({ ok: false, error: "net::ERR_ABORTED" });
      return;
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = Number(target.port === "" ? "80" : target.port);
    const request = get({ host, port, path: `${target.pathname}${target.search}`, createConnection: () => connect({ host, port, autoSelectFamily: true }), timeout: 15_000 }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => {
      resolve({ ok: false, error: "net::ERR_CONNECTION_REFUSED" });
    });
  });

const navigate = async (page: Page, url: string, sessionId: string | undefined, loaded: Page["loaded"] = "navigate"): Promise<string | null> => {
  page.url = url;
  page.loaded = loaded;
  if (url === "about:blank") {
    page.title = "";
    return null;
  }
  const fetched = await fetchPage(url);
  if (!fetched.ok) {
    page.title = "";
    return fetched.error;
  }
  page.title = /<title>([^<]*)<\/title>/i.exec(fetched.body)?.[1]?.trim() ?? "";
  if (sessionId !== undefined) {
    event("Page.loadEventFired", { timestamp: Date.now() / 1000 }, sessionId);
    event("Page.lifecycleEvent", { frameId: page.targetId, loaderId: `L${page.targetId}`, name: "networkIdle", timestamp: Date.now() / 1000 }, sessionId);
  }
  return null;
};

const newPage = (url: string): Page => {
  counter += 1;
  const page: Page = { targetId: `T${String(counter)}`, url, title: "", viewport: { width: 1440, height: 900 }, loaded: "navigate", inputs: 0, screencast: null };
  pages.set(page.targetId, page);
  return page;
};

const pumpScreencast = (page: Page, sessionId: string): void => {
  const cast = page.screencast;
  if (cast === null || cast.inFlight >= cast.max) return;
  cast.frame += 1;
  cast.inFlight += 1;
  event(
    "Page.screencastFrame",
    {
      data: frame(page, cast.frame, castSize(page, cast)).toString("base64"),
      metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: page.viewport.width, deviceHeight: page.viewport.height, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: Date.now() / 1000 },
      sessionId: cast.frame,
    },
    sessionId,
  );
};

const stopScreencast = (page: Page): void => {
  if (page.screencast?.timer !== undefined) clearInterval(page.screencast.timer);
  page.screencast = null;
};

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {});

const handle = async (message: Record<string, unknown>): Promise<void> => {
  const id = message["id"];
  const method = typeof message["method"] === "string" ? message["method"] : "";
  const params = record(message["params"]);
  const sessionId = typeof message["sessionId"] === "string" ? message["sessionId"] : undefined;
  const page = sessionId === undefined ? undefined : sessions.get(sessionId);
  const reply = (result: Record<string, unknown>): void => {
    send(sessionId === undefined ? { id, result } : { id, result, sessionId });
  };
  const fail = (text: string): void => {
    send(sessionId === undefined ? { id, error: { code: -32601, message: text } } : { id, error: { code: -32601, message: text }, sessionId });
  };
  switch (method) {
    case "Browser.getVersion":
      reply({ protocolVersion: "1.3", product: FAKE_BROWSER_PRODUCT, revision: "fake", userAgent: `Mozilla/5.0 ${FAKE_BROWSER_PRODUCT}`, jsVersion: "0" });
      return;
    case "Browser.close":
      reply({});
      output.end(() => process.exit(0));
      return;
    case "Target.createTarget": {
      const created = newPage("about:blank");
      reply({ targetId: created.targetId });
      const url = typeof params["url"] === "string" ? params["url"] : "about:blank";
      await navigate(created, url, undefined);
      return;
    }
    case "Target.attachToTarget": {
      const target = pages.get(typeof params["targetId"] === "string" ? params["targetId"] : "");
      if (target === undefined) {
        fail("No target with given id found");
        return;
      }
      counter += 1;
      const attached = `S${String(counter)}`;
      sessions.set(attached, target);
      reply({ sessionId: attached });
      return;
    }
    case "Target.closeTarget": {
      const target = pages.get(typeof params["targetId"] === "string" ? params["targetId"] : "");
      if (target !== undefined) {
        stopScreencast(target);
        pages.delete(target.targetId);
        for (const [key, value] of sessions) if (value === target) sessions.delete(key);
      }
      reply({ success: target !== undefined });
      return;
    }
    case "Target.getTargets":
      reply({ targetInfos: [...pages.values()].map((each) => ({ targetId: each.targetId, type: "page", title: each.title, url: each.url, attached: true })) });
      return;
    case "Target.setDiscoverTargets":
    case "Target.detachFromTarget":
      reply({});
      return;
    default:
      break;
  }
  if (page === undefined) {
    // A page's domain without a page's session: Chromium's answer to a flattened client's slip.
    fail(`'${method}' wasn't found`);
    return;
  }
  switch (method) {
    case "Page.navigate": {
      const url = typeof params["url"] === "string" ? params["url"] : "about:blank";
      const errorText = await navigate(page, url, sessionId);
      reply({ frameId: page.targetId, loaderId: `L${page.targetId}`, ...(errorText === null ? {} : { errorText }) });
      return;
    }
    case "Page.reload":
      reply({});
      await navigate(page, page.url, sessionId, "reload");
      return;
    case "Runtime.evaluate": {
      const expression = typeof params["expression"] === "string" ? params["expression"] : "";
      if (expression.includes("document.title")) reply({ result: { type: "string", value: page.title } });
      else if (expression.includes("location.href")) reply({ result: { type: "string", value: page.url } });
      else if (expression.includes("document.readyState")) reply({ result: { type: "string", value: "complete" } });
      else if (expression.includes("getEntriesByType")) reply({ result: { type: "string", value: page.loaded } });
      else reply({ result: { type: "undefined" } });
      return;
    }
    case "Emulation.setDeviceMetricsOverride": {
      const width = Number(params["width"]);
      const height = Number(params["height"]);
      if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) page.viewport = { width, height };
      reply({});
      return;
    }
    case "Page.getLayoutMetrics": {
      const content = { x: 0, y: 0, width: page.viewport.width, height: page.viewport.height * 2 };
      const viewport = { pageX: 0, pageY: 0, clientWidth: page.viewport.width, clientHeight: page.viewport.height };
      reply({ cssContentSize: content, contentSize: content, cssLayoutViewport: viewport, layoutViewport: viewport });
      return;
    }
    case "Page.captureScreenshot": {
      const clip = record(params["clip"]);
      const size = typeof clip["width"] === "number" && typeof clip["height"] === "number" ? { width: Math.round(clip["width"]), height: Math.round(clip["height"]) } : page.viewport;
      reply({ data: (await png(size)).toString("base64") });
      return;
    }
    case "Page.startScreencast": {
      stopScreencast(page);
      const max = typeof params["maxFramesInFlight"] === "number" ? params["maxFramesInFlight"] : 1;
      const side = (name: string): number | null => {
        const value = params[name];
        return typeof value === "number" && value > 0 ? value : null;
      };
      page.screencast = { inFlight: 0, max, timer: undefined, frame: 0, maxWidth: side("maxWidth"), maxHeight: side("maxHeight") };
      reply({});
      const attached = sessionId;
      if (attached !== undefined) {
        page.screencast.timer = setInterval(() => {
          pumpScreencast(page, attached);
        }, 100);
        pumpScreencast(page, attached);
      }
      return;
    }
    case "Page.screencastFrameAck":
      if (page.screencast !== null && page.screencast.inFlight > 0) page.screencast.inFlight -= 1;
      reply({});
      return;
    case "Page.stopScreencast":
      stopScreencast(page);
      reply({});
      return;
    case "Input.dispatchMouseEvent":
    case "Input.dispatchKeyEvent":
    case "Input.insertText":
    case "Input.dispatchTouchEvent":
      page.inputs += 1;
      reply({});
      return;
    default:
      if (/\.(enable|disable)$/.test(method) || /^(Emulation|Page|Network|Runtime)\.set/.test(method)) {
        reply({});
        return;
      }
      fail(`'${method}' wasn't found`);
  }
};

const main = async (): Promise<void> => {
  // A browser keeps its profile in the folder it's given: the marker shows the folder was used.
  const profile = arg("user-data-dir");
  if (profile !== undefined) {
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(profile, "Local State"), "{}\n");
  }
  let pending: Buffer[] = [];
  let queue = Promise.resolve();
  input.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      pending.push(chunk.subarray(start, end));
      const text = Buffer.concat(pending).toString("utf8");
      pending = [];
      start = end + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      queue = queue.then(() => handle(record(parsed))).catch(() => undefined);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  });
  // A browser whose pipe closes exits, as Chromium does.
  input.on("end", () => process.exit(0));
  input.on("close", () => process.exit(0));
};

await main();
