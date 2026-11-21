import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "@playwright/test";

import { decodePreviewMessage, encodePreviewMessage, previewPaths, previewSubprotocols } from "@ostra/protocol";
import type { PreviewControl, PreviewInputEvent } from "@ostra/protocol";

import { e2eCoreUrl } from "./settings.ts";

// The box of the preview pane's spec (milestone 8, ticket 21): milestone 8's `test-web` fixture (Vite
// and React, with its counter) served on this machine and opened in a page of the spec's own
// browser, which stands in for the box's browser; and the box's side of core's preview connection
// (`GET /runner/v1/preview?view=&leaseEpoch=`, ADR 0068), which a `host` runner opens with its access
// token: it sends the page's pictures as JPEG frames, one per core's ack, and applies core's
// controls to the page (input, the viewport, a path, a reload), acking each. Everything between the
// pane and this socket is the real panel and core. The token is signed with core's own key, from the
// stack's data folder, as core signs a runner's (`apps/core/src/gateway/access-token.ts`).

const fixtureDir = path.resolve(import.meta.dirname, "..", "..", "..", "e2e", "m8-previews-and-library", "fixtures", "test-web");

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("no free port"));
      });
    });
  });

/** A runner's access token for core, as core issues one (an HMAC under its key, 10 minutes). */
export const runnerToken = async (dataDir: string, runnerId: string, organizationId: string): Promise<string> => {
  const key = Buffer.from((await readFile(path.join(dataDir, "runner-token.key"), "utf8")).trim(), "base64url");
  const body = Buffer.from(JSON.stringify({ v: 1, r: runnerId, o: organizationId, e: Date.now() + 9 * 60_000 })).toString("base64url");
  return `ostra-runner-${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
};

const killTree = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else child.kill("SIGTERM");
  await exited;
};

const waitForPort = async (port: number, ms: number): Promise<void> => {
  const until = Date.now() + ms;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "localhost");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { resolve(false); });
    });
    if (open) return;
    if (Date.now() > until) throw new Error(`nothing answered on :${String(port)}`);
    await new Promise((wait) => setTimeout(wait, 200));
  }
};

/** One view the box serves: what core sent it, and its end. */
export type BoxView = {
  /** Every control core sent, in order: the input batches, the viewport, a path, a reload. */
  readonly controls: PreviewControl[];
  /** The frames sent so far. */
  readonly frames: () => number;
  /**
   * The page at rest, as the runner sends it (F-141/c10): the moving frames stop, and one `still`
   * frame goes, at quality 90 and the box page's device pixel ratio (2), once core took the last.
   */
  readonly still: () => Promise<void>;
  /** The page moves again: the moving frames, at the page's CSS size, come again. */
  readonly resume: () => void;
  readonly input: () => readonly PreviewInputEvent[];
  readonly close: () => void;
  readonly closed: Promise<void>;
};

export type FixtureBox = {
  /** The page in the box's browser: the fixture app. */
  readonly page: Page;
  /** The fixture's Vite on this machine: the native preview's tunnel reaches the app here (ticket 26). */
  readonly webPort: number;
  /** Opens the box's preview connection for a view, as the runner does once core sends `preview.open`. */
  readonly serve: (viewId: string, leaseEpoch: number) => Promise<BoxView>;
  readonly stop: () => Promise<void>;
};

export const startFixtureBox = async (browser: Browser, options: { readonly dataDir: string; readonly runnerId: string; readonly organizationId: string }): Promise<FixtureBox> => {
  const webPort = await freePort();
  const apiPort = await freePort();
  const cacheDir = await mkdtemp(path.join(tmpdir(), "ostra-test-web-"));
  const env = { PATH: process.env["PATH"] ?? "", SYSTEMROOT: process.env["SYSTEMROOT"] ?? "", TEST_WEB_PORT: String(webPort), TEST_WEB_API_PORT: String(apiPort), TEST_WEB_CACHE_DIR: cacheDir };
  const api = spawn(process.execPath, [path.join(fixtureDir, "api", "server.js")], { cwd: fixtureDir, env, stdio: "ignore", windowsHide: true });
  const vite = spawn(process.execPath, [path.join(fixtureDir, "node_modules", "vite", "bin", "vite.js")], { cwd: fixtureDir, env, stdio: "ignore", windowsHide: true });
  const sockets = new Set<WebSocket>();
  let context: BrowserContext | null = null;
  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.close();
    await context?.close().catch(() => undefined);
    await Promise.all([killTree(api), killTree(vite)]);
    await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    await waitForPort(webPort, 60_000);
    // A HiDPI box browser, as a page whose viewer's screen is at 2 is (F-141/c10): its moving frames
    // are taken at the page's CSS size, and only a still frame at its own pixels.
    context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const origin = `http://localhost:${String(webPort)}`;
    await page.goto(origin);
    await page.locator("#counter").waitFor();

    const apply = async (control: PreviewControl): Promise<void> => {
      switch (control.kind) {
        case "viewport":
          await page.setViewportSize({ width: control.viewport.width, height: control.viewport.height });
          return;
        case "navigate":
          await page.goto(`${origin}${control.path}`);
          return;
        case "reload":
          await page.reload();
          return;
        case "input":
          for (const event of control.events) {
            switch (event.kind) {
              case "mouse": {
                const button = event.button === "none" ? "left" : event.button;
                await page.mouse.move(event.x, event.y);
                if (event.action === "down") await page.mouse.down({ button, clickCount: Math.max(1, event.clickCount) });
                if (event.action === "up") await page.mouse.up({ button, clickCount: Math.max(1, event.clickCount) });
                break;
              }
              case "wheel":
                await page.mouse.move(event.x, event.y);
                await page.mouse.wheel(event.deltaX, event.deltaY);
                break;
              case "key":
                if (event.action === "down") await page.keyboard.down(event.key);
                else await page.keyboard.up(event.key);
                break;
              case "text":
                await page.keyboard.insertText(event.text);
                break;
              default:
                event satisfies never;
            }
          }
          return;
        default:
          control satisfies never;
      }
    };

    const serve = async (viewId: string, leaseEpoch: number): Promise<BoxView> => {
      const token = await runnerToken(options.dataDir, options.runnerId, options.organizationId);
      const url = `${e2eCoreUrl.replace(/^http/, "ws")}${previewPaths.connection}?view=${encodeURIComponent(viewId)}&leaseEpoch=${String(leaseEpoch)}`;
      // Node's own WebSocket takes headers (the DOM's type doesn't say so): the box's bearer token.
      const made: unknown = Reflect.construct(WebSocket, [url, { protocols: [previewSubprotocols.stream], headers: { authorization: `Bearer ${token}` } }]);
      if (!(made instanceof WebSocket)) throw new Error("no WebSocket in this Node");
      const socket = made;
      socket.binaryType = "arraybuffer";
      sockets.add(socket);
      const controls: PreviewControl[] = [];
      // An object, since the socket's handlers change it between the loop's awaits.
      const state = { acked: 0, sent: 0, open: true, resting: false, moving: false };
      const closed = new Promise<void>((resolve) => {
        socket.addEventListener("close", () => {
          state.open = false;
          sockets.delete(socket);
          resolve();
        });
      });
      // Core's controls, applied in order; each acked once it's applied.
      let applying: Promise<void> = Promise.resolve();
      socket.addEventListener("message", (message) => {
        const data: unknown = message.data;
        if (!(data instanceof ArrayBuffer)) return;
        const parsed = decodePreviewMessage(new Uint8Array(data));
        if (!parsed.ok) return;
        const received = parsed.message;
        if (received.type === "ack") state.acked = Math.max(state.acked, received.ack.seq);
        if (received.type === "close") socket.close();
        if (received.type === "control") {
          controls.push(received.control);
          const { control } = received;
          applying = applying.then(async () => {
            await apply(control).catch(() => undefined);
            if (state.open) socket.send(new Uint8Array(encodePreviewMessage({ type: "ack", ack: { seq: control.seq } })));
          });
        }
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => { resolve(); }, { once: true });
        socket.addEventListener("error", () => { reject(new Error(`the box's preview connection for ${viewId} was refused`)); }, { once: true });
      });
      // The pictures: one frame at a time, the next once core acked the last (its back-pressure).
      const live = (): boolean => state.open;
      const behind = (): boolean => state.acked < state.sent;
      const resting = (): boolean => state.resting;
      void (async () => {
        while (live()) {
          if (resting()) {
            state.moving = false;
            await new Promise((wait) => setTimeout(wait, 50));
            continue;
          }
          state.moving = true;
          const size = page.viewportSize() ?? { width: 800, height: 600 };
          const jpeg = await page.screenshot({ type: "jpeg", quality: 70, scale: "css" }).catch(() => null);
          if (jpeg === null || !live()) break;
          state.sent += 1;
          socket.send(new Uint8Array(encodePreviewMessage({ type: "frame", header: { seq: state.sent, at: Date.now(), width: size.width, height: size.height }, jpeg: new Uint8Array(jpeg) })));
          const until = Date.now() + 3_000;
          while (live() && behind() && Date.now() < until) await new Promise((wait) => setTimeout(wait, 20));
          await new Promise((wait) => setTimeout(wait, 120));
        }
      })();
      const waitTaken = async (): Promise<void> => {
        const until = Date.now() + 5_000;
        while (live() && behind() && Date.now() < until) await new Promise((wait) => setTimeout(wait, 20));
      };
      return {
        controls,
        frames: () => state.sent,
        still: async () => {
          state.resting = true;
          // The moving frame in flight first, as the runner's still waits for the page to rest.
          const until = Date.now() + 5_000;
          while (live() && state.moving && Date.now() < until) await new Promise((wait) => setTimeout(wait, 20));
          await waitTaken();
          const size = page.viewportSize() ?? { width: 800, height: 600 };
          const jpeg = await page.screenshot({ type: "jpeg", quality: 90, scale: "device" });
          state.sent += 1;
          socket.send(new Uint8Array(encodePreviewMessage({ type: "frame", header: { seq: state.sent, at: Date.now(), width: size.width, height: size.height, still: true }, jpeg: new Uint8Array(jpeg) })));
          await waitTaken();
        },
        resume: () => {
          state.resting = false;
        },
        input: () => controls.flatMap((control) => (control.kind === "input" ? control.events : [])),
        close: () => { socket.close(); },
        closed,
      };
    };

    return { page, webPort, serve, stop };
  } catch (error) {
    await stop();
    throw error;
  }
};
