import { BROWSER_VERSION_CALL_ID, browserChannel } from "@ostra/adapter-sdk";
import type { BrowserChannel } from "@ostra/adapter-sdk";
import { localProcesses, processTreeContainment } from "@ostra/adapter-executor-host";
import { fakeBrowserProgram } from "@ostra/adapter-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { boxBrowser } from "./box-browser.ts";
import type { BoxBrowserReport } from "./box-browser.ts";
import { createDevToolsClient, isDevToolsError } from "./devtools-client.ts";
import { openPage } from "./page.ts";

// Milestone 8 (ticket 11, F-121): ostra's DevTools client, over a channel this test plays the
// browser on (deadlines, refused replies, the browser going away), then over the fake box browser
// through the `host` processes seam: a target opened, navigated, captured, screencast with acks,
// given input and closed. The pixels are the live test's (`box-browser.host.test.ts`).

/** A channel whose browser is this test: what the client sends, and a way to answer. */
const scriptedChannel = (): BrowserChannel & { readonly sent: unknown[]; readonly answer: (message: string) => void; readonly end: () => void } => {
  const listeners = new Set<(message: string) => void>();
  const sent: unknown[] = [];
  let end = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    end = resolve;
  });
  return {
    sent,
    send: (message) => {
      sent.push(JSON.parse(message));
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    closed,
    close: () => {
      end();
      return Promise.resolve();
    },
    answer: (message) => {
      for (const listener of listeners) listener(message);
    },
    end: () => {
      end();
    },
  };
};

const idOf = (message: unknown): number => Number(Reflect.get(Object(message), "id"));

describe("ostra's DevTools client", () => {
  it("F-121/c2: a call past its deadline fails with its method's name, and a late reply is dropped", async () => {
    const channel = scriptedChannel();
    const client = createDevToolsClient(channel, { deadlineMs: 50 });
    const late = client.call("Page.captureScreenshot", {}, z.looseObject({ data: z.string() }));
    await expect(late).rejects.toMatchObject({ kind: "deadline", method: "Page.captureScreenshot" });
    channel.answer(JSON.stringify({ id: idOf(channel.sent[0]), result: { data: "late" } }));
    // A call with its own deadline outlives the client's.
    const own = client.call("Browser.getVersion", {}, z.looseObject({ product: z.string() }), { deadlineMs: 2_000 });
    setTimeout(() => {
      channel.answer(JSON.stringify({ id: idOf(channel.sent[1]), result: { product: "Chrome/158" } }));
    }, 100);
    await expect(own).resolves.toMatchObject({ product: "Chrome/158" });
  });

  it("F-121/c2: refuses a reply it can't parse: not JSON, not a DevTools message, or a result of another shape", async () => {
    const channel = scriptedChannel();
    const client = createDevToolsClient(channel);
    const call = client.call("Target.createTarget", { url: "about:blank" }, z.looseObject({ targetId: z.string().min(1) }));
    channel.answer("not json {");
    channel.answer(JSON.stringify(["a", "list"]));
    channel.answer(JSON.stringify({ id: "1", result: {} }));
    expect(client.refused()).toBe(3);
    // The reply is a DevTools message, with fields the client doesn't know, but no `targetId`.
    channel.answer(JSON.stringify({ id: idOf(channel.sent[0]), result: { somethingElse: true }, extra: "ignored" }));
    const error: unknown = await call.catch((caught: unknown) => caught);
    expect(isDevToolsError(error) && error.kind).toBe("unparsable");
    // A protocol error keeps Chromium's words out of the message, in `detail`.
    const refusedCall = client.command("Page.navigate", { url: "http://localhost:1/" });
    channel.answer(JSON.stringify({ id: idOf(channel.sent[1]), error: { code: -32000, message: "Cannot navigate to <secret page text>" } }));
    const protocolError: unknown = await refusedCall.catch((caught: unknown) => caught);
    expect(isDevToolsError(protocolError) && protocolError.kind).toBe("protocol");
    expect(protocolError instanceof Error && protocolError.message).not.toContain("secret page text");
    expect(isDevToolsError(protocolError) && protocolError.detail).toContain("Cannot navigate");
  });

  it("F-121/c2: hears events in order, keeps its IDs below the executors' own, and fails what's waiting once the browser is gone", async () => {
    const channel = scriptedChannel();
    const client = createDevToolsClient(channel);
    const heard: string[] = [];
    const off = client.onEvent((event) => heard.push(`${event.method}@${event.sessionId ?? "browser"}`));
    channel.answer(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" }));
    channel.answer(JSON.stringify({ method: "Target.targetCreated", params: {} }));
    // The executor's own `Browser.getVersion` answer is left to it.
    channel.answer(JSON.stringify({ id: BROWSER_VERSION_CALL_ID, result: { product: "x" } }));
    off();
    channel.answer(JSON.stringify({ method: "Page.frameNavigated", params: {} }));
    expect(heard).toEqual(["Page.loadEventFired@S1", "Target.targetCreated@browser"]);
    const waiting = client.command("Page.reload", {});
    expect(idOf(channel.sent[0])).toBeLessThan(BROWSER_VERSION_CALL_ID);
    channel.end();
    await expect(waiting).rejects.toMatchObject({ kind: "closed", method: "Page.reload" });
    await expect(client.command("Page.reload", {})).rejects.toMatchObject({ kind: "closed" });
  });
});

describe("a page of the box's browser, over the fake browser's pipe", () => {
  const ends: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const end of ends.splice(0)) await end();
  });

  const fakeBox = async (): Promise<ReturnType<typeof createDevToolsClient>> => {
    const processes = localProcesses(processTreeContainment, () => Promise.resolve({ available: true, program: fakeBrowserProgram(), source: "setting" }));
    const unit = await processTreeContainment().create("fake-browser-box");
    const started = await processes.startBrowser(unit, { PATH: process.env["PATH"] ?? "", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}) });
    if (!started.available) throw new Error(`no fake browser: ${started.reason}`);
    const channel = browserChannel(started.ends);
    ends.push(async () => {
      await channel.close();
      await unit.dispose();
    });
    return createDevToolsClient(channel, { deadlineMs: 15_000 });
  };

  it("F-121/c2: opens a target, navigates, captures a PNG, screencasts with acks, takes input and closes the target", async () => {
    const { createServer } = await import("node:http");
    const app = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>the fixture's page</title>");
    });
    await new Promise<void>((resolve) => app.listen(0, "localhost", resolve));
    ends.push(
      () =>
        new Promise<void>((resolve) => {
          app.close(() => {
            resolve();
          });
        }),
    );
    const address = app.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const client = await fakeBox();
    const page = await openPage(client, { width: 1440, height: 900, mobile: false });
    await page.navigate(`http://localhost:${String(address.port)}/`);
    expect(await page.evaluate("document.title", z.string())).toBe("the fixture's page");
    const png = await page.screenshot({ format: "png" });
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1440, 900]);
    // A navigation the app doesn't answer fails with the browser's own error text as its detail.
    const refused: unknown = await page.navigate("http://localhost:1/").catch((caught: unknown) => caught);
    expect(isDevToolsError(refused) && refused.method).toBe("Page.navigate");
    // The screencast: frames arrive, each acked once its reader is done, so more keep coming.
    const frames: number[] = [];
    const stop = await page.startScreencast({ format: "jpeg", quality: 60, maxWidth: 1440, maxHeight: 900, maxFramesInFlight: 1, sendLastFrame: true }, async (frame) => {
      frames.push(frame.data.length);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    for (let waited = 0; frames.length < 3 && waited < 5_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await stop();
    expect(frames.length, "frames kept coming, so each was acked").toBeGreaterThanOrEqual(3);
    await page.mouse({ type: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 });
    await page.key({ type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.insertText(" pasted: été ✓");
    await page.close();
  }, 60_000);

  it("F-121/c2: a box's browser is reported once as app.browser, started on first use and shared by its callers", async () => {
    const reports: BoxBrowserReport[] = [];
    let starts = 0;
    const processes = localProcesses(processTreeContainment, () => Promise.resolve({ available: true, program: fakeBrowserProgram(), source: "setting" }));
    const unit = await processTreeContainment().create("box-browser-holder");
    const holder = boxBrowser({
      start: async () => {
        starts += 1;
        const started = await processes.startBrowser(unit, { PATH: process.env["PATH"] ?? "", ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}) });
        if (!started.available) return { ok: true, value: { available: false, reason: started.reason } };
        return { ok: true, value: { available: true, browser: { name: "Fake", version: "1.0.0", channel: browserChannel(started.ends), profileDir: started.profileDir } } };
      },
      report: (browser) => reports.push(browser),
    });
    try {
      const [first, second] = await Promise.all([holder.open(), holder.open()]);
      expect(first.available && second.available && first.client === second.client).toBe(true);
      expect(starts).toBe(1);
      expect(reports).toEqual([{ available: true, name: "Fake", version: "1.0.0" }]);
    } finally {
      await holder.close();
      await unit.dispose();
    }
    // A box with no browser reports why, once, and keeps saying so without starting again.
    const none: BoxBrowserReport[] = [];
    const without = boxBrowser({ start: () => Promise.resolve({ ok: true, value: { available: false, reason: "not-in-image" } }), report: (browser) => none.push(browser) });
    expect(await without.open()).toEqual({ available: false, reason: "not-in-image" });
    expect(await without.open()).toEqual({ available: false, reason: "not-in-image" });
    expect(none).toEqual([{ available: false, reason: "not-in-image" }]);
  }, 60_000);
});
