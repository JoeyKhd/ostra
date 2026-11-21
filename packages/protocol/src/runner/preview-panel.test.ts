import { describe, expect, it } from "vitest";

import { previewViewIdSchema } from "../ids.ts";
import { browserViewFrameBounds, browserViewStillScale, previewViewportSchema, viewportPresetSizes } from "../task/app.ts";
import { runnerLimits } from "./limits.ts";
import { createPanelStreamReader, decodePreviewMessage, encodePanelStreamRecord, encodePreviewMessage, panelPreviewInputBodySchema, previewFrameHeaderSchema, previewFramesBodySchema, previewMessageMaxBytes } from "./preview.ts";
import type { PreviewMessage } from "./preview.ts";

// The panel's stream of a view (milestone 8, ticket 19): core's records, relayed by the web app and
// read by the pane, however the network splits them.

const jpeg = (fill: number): Uint8Array => {
  const bytes = new Uint8Array(32).fill(fill);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

const frame = (seq: number): PreviewMessage => ({ type: "frame", header: { seq, at: 1_700_000_000_000 + seq, width: 1440, height: 900 }, jpeg: jpeg(seq) });

describe("the panel's preview stream", () => {
  it("reads records split anywhere, in order", () => {
    const messages: PreviewMessage[] = [frame(1), frame(2), { type: "close", close: { reason: "closed" } }];
    const bytes = Buffer.concat(messages.map((message) => Buffer.from(encodePanelStreamRecord(message))));
    for (const size of [1, 3, 7, 50, bytes.length]) {
      const reader = createPanelStreamReader();
      const read: PreviewMessage[] = [];
      for (let at = 0; at < bytes.length; at += size) {
        for (const record of reader.push(new Uint8Array(bytes.subarray(at, at + size)))) {
          expect(record.ok).toBe(true);
          if (record.ok) {
            read.push(record.message);
          }
        }
      }
      expect(read).toEqual(messages);
      expect(reader.pending()).toBe(0);
    }
  });

  it("refuses a record longer than any message, and one that isn't a message", () => {
    const tooLong = new Uint8Array(8);
    new DataView(tooLong.buffer).setUint32(0, previewMessageMaxBytes + 1, false);
    expect(createPanelStreamReader().push(tooLong)).toEqual([{ ok: false, reason: "too-large" }]);
    const unknown = new Uint8Array([0, 0, 0, 2, 9, 9]);
    expect(createPanelStreamReader().push(unknown)).toEqual([{ ok: false, reason: "unknown-type" }]);
  });

  it("takes an input batch as a strict object", () => {
    const events = [{ kind: "text", text: "hello" }];
    expect(panelPreviewInputBodySchema.safeParse({ events }).success).toBe(true);
    expect(panelPreviewInputBodySchema.safeParse({ events, viewId: previewViewIdSchema.parse("view-1") }).success).toBe(false);
    expect(panelPreviewInputBodySchema.safeParse({ events: [] }).success).toBe(false);
  });

  it("takes one of the pane's controls as a strict object: the width preset, a path on the preview's origin, a reload", () => {
    for (const control of [{ kind: "viewport", viewport: viewportPresetSizes.tablet }, { kind: "navigate", path: "/history" }, { kind: "reload" }]) {
      expect(panelPreviewInputBodySchema.safeParse({ control }).success).toBe(true);
    }
    for (const body of [
      { control: { kind: "print" } },
      { control: { kind: "viewport", viewport: { width: 100, height: 844 } } },
      // More pixels than 1440×900's.
      { control: { kind: "viewport", viewport: { width: 1440, height: 901 } } },
      { control: { kind: "navigate", path: "https://evil.example/" } },
      { control: { kind: "reload", seq: 1 } },
      { control: { kind: "reload" }, events: [{ kind: "text", text: "hello" }] },
    ]) {
      expect(panelPreviewInputBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("F-141/c3: every width preset is a browser view's page as it is, the tablet's 834×1112 too, within 1440×900's pixels and 1920 a side, and its frames come at its own size", () => {
    for (const preset of ["desktop", "tablet", "phone"] as const) {
      const size = viewportPresetSizes[preset];
      expect(previewViewportSchema.safeParse(size).success).toBe(true);
      expect(panelPreviewInputBodySchema.safeParse({ control: { kind: "viewport", viewport: size } }).success).toBe(true);
      // The screencast's bounds are the page's own size: its pictures aren't scaled down.
      expect(browserViewFrameBounds(size)).toEqual(size);
    }
    // The cap is the pixels in all, and each side's.
    expect(runnerLimits.browserViewMaxPixels).toBe(1440 * 900);
    for (const fits of [{ width: 900, height: 1440 }, { width: 1920, height: 675 }, { width: 675, height: 1920 }, { width: 200, height: 200 }]) {
      expect(previewViewportSchema.safeParse(fits).success).toBe(true);
    }
    for (const past of [{ width: 1441, height: 900 }, { width: 1200, height: 1200 }, { width: 1921, height: 300 }, { width: 300, height: 1921 }, { width: 199, height: 844 }, { width: 834, height: 199 }, { width: 834.5, height: 900 }]) {
      expect(previewViewportSchema.safeParse(past).success).toBe(false);
    }
    // A page past the caps is screencast scaled down within them, its shape kept.
    const scaled = browserViewFrameBounds({ width: 2560, height: 1600 });
    expect(scaled.width * scaled.height).toBeLessThanOrEqual(runnerLimits.browserViewMaxPixels);
    expect(scaled.width / scaled.height).toBeCloseTo(2560 / 1600, 2);
    expect(browserViewFrameBounds({ width: 3000, height: 300 })).toEqual({ width: 1920, height: 192 });
  });

  it("F-141/c10: a viewer names its device pixel ratio with the viewport, a still frame is taken at it within 2, and a still frame's header says so on either carrier", () => {
    // The ratio rides the viewport, on the open and on the width control; absent is 1, and 1 to 4 is taken.
    for (const scale of [1, 1.25, 1.5, 2, 2.625, 3, 4]) {
      expect(previewViewportSchema.safeParse({ ...viewportPresetSizes.desktop, scale }).success, String(scale)).toBe(true);
      expect(panelPreviewInputBodySchema.safeParse({ control: { kind: "viewport", viewport: { ...viewportPresetSizes.phone, scale } } }).success).toBe(true);
    }
    for (const scale of [0, 0.5, 0.99, 4.01, Number.NaN]) {
      expect(previewViewportSchema.safeParse({ ...viewportPresetSizes.desktop, scale }).success, String(scale)).toBe(false);
    }
    // The still's ratio: the viewer's from 1 to 2, to two decimals, so its pixels are at most the page's times 4.
    expect([undefined, 0.8, 1, 1.25, 1.333, 2, 3].map(browserViewStillScale)).toEqual([1, 1, 1, 1.25, 1.33, 2, 2]);
    expect(runnerLimits.browserViewStillMaxScale).toBe(2);
    expect(runnerLimits.browserViewStillQuality).toBeGreaterThanOrEqual(90);
    expect(runnerLimits.browserViewQuality).toBe(60);
    // A still frame's header names the page's size and `still`, and travels as it is on the WebSocket.
    const still: PreviewMessage = { type: "frame", header: { seq: 7, at: 1_700_000_000_007, width: 1440, height: 900, still: true }, jpeg: jpeg(7) };
    expect(decodePreviewMessage(encodePreviewMessage(still))).toEqual({ ok: true, message: still });
    expect(previewFrameHeaderSchema.safeParse({ seq: 7, at: 1, width: 1440, height: 900, still: false }).success).toBe(false);
    // And on the HTTP carrier's posted frames.
    const viewId = previewViewIdSchema.parse("view-still");
    expect(previewFramesBodySchema.safeParse({ viewId, leaseEpoch: 1, frames: [{ seq: 7, at: 1, width: 1440, height: 900, still: true, part: "frame-0" }] }).success).toBe(true);
    // The pane's stream carries it too.
    const reader = createPanelStreamReader();
    expect(reader.push(encodePanelStreamRecord(still))).toEqual([{ ok: true, message: still }]);
  });
});
