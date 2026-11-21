import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { browserChannel, identifyBrowser, killTree, silentLogger } from "@ostra/adapter-sdk";
import type { BrowserChannel } from "@ostra/adapter-sdk";
import type { BoxBrowser } from "@ostra/protocol";
import { boxIdSchema } from "@ostra/protocol";
import { listenForInit } from "../bridge/bridge-server.ts";
import type { Bridge } from "../bridge/bridge-server.ts";
import { BRIDGE_FEATURES } from "../bridge/protocol.ts";

// Milestone 8 (ticket 11, F-121): the executor suite's browser case, as the `live-docker` and
// `live-kind` jobs run it inside a container of the base image, under a box's hardening (every
// capability dropped but the init's three, no new privileges, a read-only root on `kubernetes`):
// the real init, connected over the real bridge to this probe, which plays the sidecar; the init
// starts an app process as the agent's user, then the image's Chromium with its container flags
// and a fresh profile in `/tmp`; the probe loads the app's page at `localhost` through the pipe,
// takes a PNG, closes the browser and checks its profile is gone. The suite itself needs the
// sidecar's container on the box network, which a job can't drive without a task, so this is the
// browser case where the image's Chromium is. Its unit test runs it with the fake browser.
//
// It prints one line, its result as JSON: names, numbers and the step that failed, never the page.

export type BrowserProbeResult =
  | {
      readonly ok: true;
      readonly browser: BoxBrowser;
      readonly title: string;
      readonly png: { readonly bytes: number; readonly width: number; readonly height: number };
      readonly profileRemoved: boolean;
    }
  | { readonly ok: false; readonly step: string; readonly detail: string };

export type BrowserProbeOptions = {
  /** The init to start: its program and arguments (the image's `main.ts`, or the tests' init with the fake browser). */
  readonly init: { readonly command: string; readonly args: readonly string[] };
  /** The init's own environment beside the bridge's: `PATH`, and `OSTRA_BOX_BROWSER` to name another browser. */
  readonly env: Readonly<Record<string, string>>;
  /** Each step's deadline. Default 60 s. */
  readonly stepMs?: number;
};

/** The probe's app: a page on `localhost` (IPv6 or IPv4, as a dev server picks) that says its port. */
const APP_TITLE = "ostra box browser probe";
const APP = [
  "const http = require('node:http');",
  `const page = '<!doctype html><html><head><title>${APP_TITLE}</title></head><body><h1>The box browser</h1><p>Liberation and emoji: Aa 🙂</p></body></html>';`,
  "const server = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); });",
  "server.listen(0, 'localhost', () => console.log('listening ' + server.address().port));",
].join("\n");

const within = <T>(promise: Promise<T>, ms: number, step: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${step} took longer than ${String(ms)} ms`));
      }, ms).unref();
    }),
  ]);

/** A plain object's own fields, or none. */
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

/** A minimal DevTools caller over the channel: the runner's client is `apps/runner`'s, which the image doesn't carry. */
const caller = (channel: BrowserChannel): ((method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>) & {
  readonly next: (method: string, sessionId: string) => Promise<void>;
} => {
  let id = 1;
  const waiting = new Map<number, { readonly resolve: (value: Record<string, unknown>) => void; readonly reject: (error: Error) => void }>();
  const events = new Map<string, () => void>();
  channel.onMessage((text) => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const replyId: unknown = Reflect.get(Object(message), "id");
    const method: unknown = Reflect.get(Object(message), "method");
    if (typeof replyId === "number") {
      const waiter = waiting.get(replyId);
      waiting.delete(replyId);
      const error: unknown = Reflect.get(Object(message), "error");
      if (error !== undefined) waiter?.reject(new Error(`DevTools error ${String(Reflect.get(Object(error), "code"))}`));
      else waiter?.resolve(record(Reflect.get(Object(message), "result")));
    } else if (typeof method === "string") {
      const key = `${method}@${String(Reflect.get(Object(message), "sessionId"))}`;
      events.get(key)?.();
      events.delete(key);
    }
  });
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const own = id;
      id += 1;
      waiting.set(own, { resolve, reject });
      channel.send(JSON.stringify(sessionId === undefined ? { id: own, method, params } : { id: own, method, params, sessionId }));
    });
  return Object.assign(call, {
    next: (method: string, sessionId: string) =>
      new Promise<void>((resolve) => {
        events.set(`${method}@${sessionId}`, resolve);
      }),
  });
};

const gone = async (target: string, ms: number): Promise<boolean> => {
  for (let waited = 0; waited <= ms; waited += 250) {
    const there = await stat(target).then(
      () => true,
      () => false,
    );
    if (!there) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

export const probeBoxBrowser = async (options: BrowserProbeOptions): Promise<BrowserProbeResult> => {
  const stepMs = options.stepMs ?? 60_000;
  const boxId = boxIdSchema.parse(`probe-${randomBytes(4).toString("hex")}`);
  const nonce = randomBytes(32).toString("base64url");
  const listener = await listenForInit({ boxId, nonce, host: "127.0.0.1", port: 0, logger: silentLogger });
  const init = spawn(options.init.command, [...options.init.args], {
    env: {
      ...options.env,
      OSTRA_BOX_ID: boxId,
      OSTRA_BRIDGE_NONCE: nonce,
      OSTRA_BRIDGE_ADDR: `127.0.0.1:${String(listener.port)}`,
      OSTRA_BRIDGE_FEATURES: BRIDGE_FEATURES.join(","),
    },
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  let step = "the init's bridge";
  let bridge: Bridge | undefined;
  let stopApp: (() => Promise<void>) | undefined;
  try {
    bridge = await within(listener.connected, stepMs, step);
    step = "the app process";
    // Its own environment only: the path, and on Windows the system root a socket needs.
    const appEnv = Object.fromEntries(Object.entries(options.env).filter(([name]) => name === "PATH" || name === "SystemRoot"));
    const app = await bridge.spawnApp({ command: process.execPath, args: ["-e", APP], cwd: tmpdir(), env: appEnv });
    stopApp = () => app.stop(1_000);
    const port = await within(
      new Promise<number>((resolve) => {
        let text = "";
        app.stdout.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
          const found = /listening (\d+)/.exec(text)?.[1];
          if (found !== undefined) resolve(Number(found));
        });
      }),
      stepMs,
      step,
    );
    step = "the browser's start";
    const started = await within(bridge.startBrowser(), stepMs, step);
    if (!started.available) return { ok: false, step, detail: started.reason };
    const channel = browserChannel(started.ends);
    const identity = await identifyBrowser(channel, started.program);
    if (identity === null) return { ok: false, step, detail: "the browser didn't answer Browser.getVersion" };
    step = "its fresh profile";
    if (!(await stat(started.profileDir).then((info) => info.isDirectory(), () => false))) return { ok: false, step, detail: "no profile folder" };
    step = "the page at the app's localhost";
    const call = caller(channel);
    const { targetId } = await within(call("Target.createTarget", { url: "about:blank" }), stepMs, step);
    const { sessionId } = await within(call("Target.attachToTarget", { targetId, flatten: true }), stepMs, step);
    if (typeof targetId !== "string" || typeof sessionId !== "string") return { ok: false, step, detail: "no target" };
    await within(call("Page.enable", {}, sessionId), stepMs, step);
    await within(call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId), stepMs, step);
    const loaded = call.next("Page.loadEventFired", sessionId);
    const navigated = await within(call("Page.navigate", { url: `http://localhost:${String(port)}/` }, sessionId), stepMs, step);
    if (navigated["errorText"] !== undefined) return { ok: false, step, detail: "the navigation failed" };
    await within(loaded, stepMs, step);
    const evaluated = await within(call("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId), stepMs, step);
    const title: unknown = Reflect.get(Object(evaluated["result"]), "value");
    step = "the screenshot";
    const shot = await within(call("Page.captureScreenshot", { format: "png" }, sessionId), stepMs, step);
    const png = Buffer.from(typeof shot["data"] === "string" ? shot["data"] : "", "base64");
    if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return { ok: false, step, detail: "not a PNG" };
    step = "the browser's end";
    await within(channel.close(), stepMs, step);
    return {
      ok: true,
      browser: identity,
      title: typeof title === "string" ? title.slice(0, 100) : "",
      png: { bytes: png.length, width: png.readUInt32BE(16), height: png.readUInt32BE(20) },
      profileRemoved: await gone(started.profileDir, 20_000),
    };
  } catch (error) {
    return { ok: false, step, detail: error instanceof Error ? error.message : "failed" };
  } finally {
    await stopApp?.().catch(() => undefined);
    bridge?.close();
    await listener.close().catch(() => undefined);
    if (init.pid !== undefined && init.exitCode === null) await killTree(init.pid);
  }
};
