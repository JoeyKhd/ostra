import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { browserChannel, browserIdentity, createPipeMessageSplitter, dialApp, identifyBrowser, openAppLog, portRefusalWords, spliceStreams } from "./app.ts";
import type { BrowserProcessEnds } from "./app.ts";

// Milestone 8 (ticket 03): the shared parts of the box's app that every executor uses, below the
// executor suite's cases: the log's cap, the pipe's framing and channel, the browser's name, the
// refusals' words, and the tunnel's splice.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("an app process's log", () => {
  it("F-140/c5: keeps everything under its cap, and past it the newest half, from a line's start", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ostra-app-log-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, ".ostra", "app", "web.log");
    const log = await openAppLog(file, 1000);
    for (let line = 1; line <= 40; line += 1) {
      log.write(Buffer.from(`line ${String(line).padStart(3, "0")} $(whoami) of the dev server\n`));
    }
    await log.close();
    const text = await readFile(file, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1000);
    expect(text.startsWith("line ")).toBe(true);
    expect(text.trimEnd().endsWith("line 040 $(whoami) of the dev server")).toBe(true);
    expect(text).not.toContain("line 001");
  });

  it("starts afresh each time it's opened, as each run of a process gets its own log", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ostra-app-log-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "api.log");
    const first = await openAppLog(file);
    first.write(Buffer.from("the first run\n"));
    await first.close();
    const second = await openAppLog(file);
    second.write(Buffer.from("the second run\n"));
    await second.close();
    expect(await readFile(file, "utf8")).toBe("the second run\n");
  });
});

describe("the browser's pipe", () => {
  it("splits NUL-ended messages across chunks, and a message cut anywhere comes whole", () => {
    const got: string[] = [];
    const push = createPipeMessageSplitter((message) => got.push(message));
    push(Buffer.from('{"id":1}\0{"id"'));
    push(Buffer.from(":2,\"result\":{}}\0\0"));
    expect(got).toEqual(['{"id":1}', '{"id":2,"result":{}}']);
  });

  it("F-121/c8: names the browser by its program when it's a known one, else by DevTools' product", () => {
    expect(browserIdentity("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "HeadlessEdg/157.0.4341.60")).toEqual({ name: "Edge", version: "157.0.4341.60" });
    expect(browserIdentity("/usr/bin/chromium", "HeadlessChrome/142.0.7444.59")).toEqual({ name: "Chromium", version: "142.0.7444.59" });
    expect(browserIdentity("/opt/ostra/chrome-headless-shell", "HeadlessChrome/142.0.7444.59")).toEqual({ name: "Chrome Headless Shell", version: "142.0.7444.59" });
    expect(browserIdentity("node", "OstraFakeBrowser/1.0.0")).toEqual({ name: "OstraFakeBrowser", version: "1.0.0" });
  });

  it("F-121/c8: a channel asks the browser its version first, and closes it with Browser.close before its kill", async () => {
    const written: string[] = [];
    let hear: (bytes: Buffer) => void = () => undefined;
    let endIt: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      endIt = resolve;
    });
    let killed = 0;
    const ends: BrowserProcessEnds = {
      write: (bytes) => {
        const text = bytes.toString("utf8").replace(/\0$/, "");
        written.push(text);
        const message: unknown = JSON.parse(text);
        const id: unknown = Reflect.get(Object(message), "id");
        if (Reflect.get(Object(message), "method") === "Browser.getVersion") {
          hear(Buffer.from(`${JSON.stringify({ id, result: { product: "HeadlessChrome/142.0.1.2" } })}\0`));
        }
        if (Reflect.get(Object(message), "method") === "Browser.close") {
          endIt();
        }
      },
      onBytes: (listener) => {
        hear = listener;
      },
      gone,
      kill: () => {
        killed += 1;
        return Promise.resolve();
      },
    };
    const channel = browserChannel(ends);
    expect(await identifyBrowser(channel, "/usr/bin/chromium")).toEqual({ name: "Chromium", version: "142.0.1.2" });
    await channel.close();
    expect(written.map((text): unknown => Reflect.get(Object(JSON.parse(text)), "method"))).toEqual(["Browser.getVersion", "Browser.close"]);
    expect(killed).toBe(1);
    // Nothing goes to a browser that's gone.
    channel.send('{"id":9,"method":"Page.reload"}');
    expect(written).toHaveLength(2);
  });
});

describe("a port's refusal, and the tunnel's splice", () => {
  it("F-143/c3: words name the port and why, never more", () => {
    expect(portRefusalWords(22, { reason: "below-min" })).toBe("port 22 isn't an app's: a preview reaches ports from 1024 up");
    expect(portRefusalWords(45001, { reason: "reserved", name: "key-proxy" })).toBe("port 45001 is the box's own (key-proxy): no preview reaches it");
  });

  it("F-143/c2: a splice carries a large answer whole when its far end closes right after it, as spike 08 needed", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 7, 0x62);
    const app: Server = createServer((socket) => {
      socket.end(big);
    });
    await new Promise<void>((resolve) => app.listen(0, "localhost", resolve));
    const appAddress: AddressInfo | string | null = app.address();
    if (appAddress === null || typeof appAddress === "string") throw new Error("no port");
    const relay: Server = createServer((socket) => {
      spliceStreams(socket, dialApp("localhost", appAddress.port));
    });
    await new Promise<void>((resolve) => relay.listen(0, "localhost", resolve));
    const relayAddress: AddressInfo | string | null = relay.address();
    if (relayAddress === null || typeof relayAddress === "string") throw new Error("no port");
    cleanups.push(
      () =>
        new Promise((resolve) => {
          app.close(() => {
            resolve();
          });
        }),
      () =>
        new Promise((resolve) => {
          relay.close(() => {
            resolve();
          });
        }),
    );
    const received = await new Promise<number>((resolve) => {
      let bytes = 0;
      const socket = dialApp("localhost", relayAddress.port);
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      socket.on("close", () => {
        resolve(bytes);
      });
    });
    expect(received).toBe(big.length);
  });
});
