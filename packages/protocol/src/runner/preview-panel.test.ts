import { describe, expect, it } from "vitest";

import { previewViewIdSchema } from "../ids.ts";
import { createPanelStreamReader, encodePanelStreamRecord, panelPreviewInputBodySchema, previewMessageMaxBytes } from "./preview.ts";
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
    for (const control of [{ kind: "viewport", viewport: { width: 834, height: 900 } }, { kind: "navigate", path: "/history" }, { kind: "reload" }]) {
      expect(panelPreviewInputBodySchema.safeParse({ control }).success).toBe(true);
    }
    for (const body of [
      { control: { kind: "print" } },
      { control: { kind: "viewport", viewport: { width: 100, height: 844 } } },
      // The browser view's page is at most 1440×900: the tablet's screenshot preset, 834×1112, isn't one.
      { control: { kind: "viewport", viewport: { width: 834, height: 1112 } } },
      { control: { kind: "navigate", path: "https://evil.example/" } },
      { control: { kind: "reload", seq: 1 } },
      { control: { kind: "reload" }, events: [{ kind: "text", text: "hello" }] },
    ]) {
      expect(panelPreviewInputBodySchema.safeParse(body).success).toBe(false);
    }
  });
});
