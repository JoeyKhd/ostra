import { describe, expect, it } from "vitest";

import { encodePanelStreamRecord, previewCloseReasonSchema, previewOpenRefusalSchema, previewRefusalReasonSchema, previewViewIdSchema } from "@ostra/protocol";
import type { PreviewMessage } from "@ostra/protocol";

import { coalesce, createInputBatcher, heldButton, modifiersOf, pagePoint, postPreviewInput, textEvents, wheelPixels } from "./preview-input";
import type { InputTimers } from "./preview-input";
import { openPreviewStream, PREVIEW_LINK_HEADER, readPreviewStream, refusalRetries } from "./preview-stream";
import type { PreviewFrame } from "./preview-stream";
import { boxRefusalWords, closeWords, previewabilityWords, routeWords } from "./preview-words";

// The browser view in the panel (milestone 8, ticket 21, F-141, F-142): the stream of a view read
// as its records arrive, the viewer's input mapped from the frame to the shared page and batched in
// order, and the words for every way a view ends. The live run is `e2e/24-preview.spec.ts`.

const viewId = previewViewIdSchema.parse("0193a1f0-0000-7000-8000-00000000f001");

const jpeg = (fill: number): Uint8Array => {
  const bytes = new Uint8Array(48).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

const frame = (seq: number): PreviewMessage => ({ type: "frame", header: { seq, at: 1_000 + seq, width: 1280, height: 800 }, jpeg: jpeg(seq) });

/** A body that hands over `bytes` in pieces of `size`, however the network cut them. */
const body = (bytes: Uint8Array, size: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("a view's stream", () => {
  it("F-141/c2: the pane reads each JPEG frame however the network splits the records, and core's close record ends it with its reason", async () => {
    const closing: PreviewMessage = { type: "close", close: { reason: "app-stopped" } };
    const bytes = join([frame(1), frame(2), frame(3), closing].map((message) => encodePanelStreamRecord(message)));
    for (const size of [1, 7, 64, bytes.length]) {
      const frames: PreviewFrame[] = [];
      const end = await readPreviewStream(body(bytes, size), (got) => frames.push(got), new AbortController().signal);
      expect(frames.map((got) => got.header.seq)).toEqual([1, 2, 3]);
      expect(frames[1]?.jpeg[2]).toBe(2);
      expect(end).toEqual({ kind: "closed", close: { reason: "app-stopped" } });
    }
  });

  it("F-141/c2: a body that ends without its close record, or breaks, is a drop the pane tries again; a refusal says its code", async () => {
    const cut = encodePanelStreamRecord(frame(1));
    expect(await readPreviewStream(body(cut.slice(0, cut.length - 3), 5), () => undefined, new AbortController().signal)).toEqual({ kind: "dropped" });
    const send = (status: number, payload: unknown): typeof fetch => () => Promise.resolve(Response.json(payload, { status }));
    expect(await openPreviewStream(viewId, null, () => undefined, new AbortController().signal, send(409, { error: { code: "not-connected" } }))).toEqual({ kind: "refused", status: 409, code: "not-connected" });
    expect(await openPreviewStream(viewId, null, () => undefined, new AbortController().signal, send(403, { error: { code: "link-revoked" } }))).toEqual({ kind: "refused", status: 403, code: "link-revoked" });
    expect(refusalRetries("not-connected")).toBe(true);
    expect(refusalRetries("core-unreachable")).toBe(true);
    expect(refusalRetries("link-revoked")).toBe(false);
    expect(refusalRetries("view-closed")).toBe(false);
  });

  it("F-142/c1: the viewer page asks for its view with the link's token in its header, and the pane with none", async () => {
    const seen: Headers[] = [];
    const send: typeof fetch = (_input, init) => {
      seen.push(new Headers(init?.headers));
      return Promise.resolve(new Response(body(encodePanelStreamRecord({ type: "close", close: { reason: "closed" } }), 4), { status: 200 }));
    };
    await openPreviewStream(viewId, "the-link-token", () => undefined, new AbortController().signal, send);
    await openPreviewStream(viewId, null, () => undefined, new AbortController().signal, send);
    expect(seen[0]?.get(PREVIEW_LINK_HEADER)).toBe("the-link-token");
    expect(seen[1]?.get(PREVIEW_LINK_HEADER)).toBeNull();
  });
});

describe("a viewer's input", () => {
  it("F-141/c2: a click on the scaled frame lands on the shared page's own pixel, kept on the page", () => {
    // The page is 1280 × 800, drawn at half its size from (100, 50).
    const rect = { left: 100, top: 50, width: 640, height: 400 };
    expect(pagePoint({ x: 100 + 320, y: 50 + 200 }, rect, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
    expect(pagePoint({ x: 0, y: 9_999 }, rect, { width: 1280, height: 800 })).toEqual({ x: 0, y: 799 });
    expect(modifiersOf({ altKey: true, ctrlKey: false, metaKey: true, shiftKey: true })).toBe(1 + 4 + 8);
    expect(heldButton(2)).toBe("right");
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(-1, 2, 800)).toBe(-800);
  });

  it("F-141/c2: input goes in order, a move after a move folds into the last, wheels at one point add up, and pasted text is cut by code point", async () => {
    const move = (x: number) => ({ kind: "mouse" as const, action: "move" as const, x, y: 10, button: "none" as const, clickCount: 0, modifiers: 0 });
    const down = { kind: "mouse" as const, action: "down" as const, x: 30, y: 10, button: "left" as const, clickCount: 1, modifiers: 0 };
    expect(coalesce(coalesce([move(1)], move(2)), down)).toEqual([move(2), down]);
    const wheel = { kind: "wheel" as const, x: 5, y: 5, deltaX: 0, deltaY: 40, modifiers: 0 };
    expect(coalesce([wheel], wheel)).toEqual([{ ...wheel, deltaY: 80 }]);
    const long = "é".repeat(5_000);
    const pieces = textEvents(long);
    expect(pieces.map((piece) => (piece.kind === "text" ? Array.from(piece.text).length : 0))).toEqual([4096, 904]);

    // The batches go one at a time, in the order the events happened.
    const sent: string[][] = [];
    let release: () => void = () => undefined;
    const timers: InputTimers = { set: () => setTimeout(() => undefined, 0), clear: () => undefined };
    const batcher = createInputBatcher(
      (events) => {
        sent.push(events.map((event) => (event.kind === "mouse" ? event.action : event.kind)));
        return sent.length === 1 ? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
      },
      40,
      timers,
    );
    batcher.push(down);
    const first = batcher.flush();
    batcher.push({ ...down, action: "up" });
    const second = batcher.flush();
    await new Promise((settle) => setTimeout(settle, 0));
    // The second waits for the first to be answered.
    expect(sent).toEqual([["down"]]);
    release();
    await first;
    await second;
    expect(sent).toEqual([["down"], ["up"]]);
  });

  it("F-142/c1: a refused post says its code, so a watch-only viewer's input never reads as sent", async () => {
    const answer = await postPreviewInput(viewId, "token", { events: [{ kind: "text", text: "x" }] }, () => Promise.resolve(Response.json({ error: { code: "watch-only" } }, { status: 403 })));
    expect(answer).toEqual({ ok: false, status: 403, code: "watch-only" });
  });
});

describe("the words for a view's end", () => {
  it("F-141/c1, F-142/c4: every box refusal, close reason, route code and runner refusal has its own words, never a key", () => {
    const all = [
      ...previewOpenRefusalSchema.options.map((refusal) => boxRefusalWords(refusal)),
      ...previewCloseReasonSchema.options.map((reason) => closeWords({ reason })),
      ...(["unauthorized", "forbidden", "not-found", "view-closed", "watch-only", "not-allowed", "link-expired", "link-revoked", "public-links-off", "level-unknown", "bad-request", "too-many-tries", "not-connected", "core-unreachable"] as const).map((code) => routeWords(code)),
      ...previewRefusalReasonSchema.options.map((reason) => previewabilityWords(reason, "build-fleet-03")),
    ];
    for (const words of all) expect(words).not.toMatch(/^previewWords\./);
    expect(new Set(all).size).toBeGreaterThan(all.length - 3);
    expect(closeWords({ reason: "refused", refusal: "too-many-pages" })).toContain("three previews at most");
    expect(previewabilityWords("runner-needs-upgrade", "build-fleet-03")).toBe("build-fleet-03 needs upgrading to show previews (protocol 1.7 or later).");
  });
});
