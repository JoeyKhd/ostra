import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createVersionedCodec, minorWindow, negotiate, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./version.ts";
import type { MinorCodec } from "./version.ts";

describe("negotiate", () => {
  const server = 5;

  it.each([4, 5, 6])("accepts a peer at minor %i against a server at 5", (peer) => {
    expect(negotiate(server, PROTOCOL_MAJOR, peer)).toEqual({ ok: true, minor: Math.min(server, peer) });
  });

  it.each([3, 7])("refuses a peer at minor %i, with the window", (peer) => {
    expect(negotiate(server, PROTOCOL_MAJOR, peer)).toEqual({ ok: false, reason: "minor", window: { min: 4, max: 6 } });
  });

  it("refuses another major", () => {
    expect(negotiate(server, PROTOCOL_MAJOR + 1, server)).toEqual({
      ok: false,
      reason: "major",
      window: { min: 4, max: 6 },
    });
  });

  it("speaks minor 0 with a newer peer at milestone 1, and never goes below 0", () => {
    expect(negotiate(PROTOCOL_MINOR, PROTOCOL_MAJOR, 1)).toEqual({ ok: true, minor: 0 });
    expect(minorWindow(0)).toEqual({ min: 0, max: 1 });
    expect(negotiate(0, PROTOCOL_MAJOR, -1)).toMatchObject({ ok: false });
  });
});

// The codec machinery with two minors, the way minor 1 will use it: minor 1 adds `labels`.
type Frame = { readonly type: "status"; readonly capacity: number; readonly labels: readonly string[] };

const v0 = z.strictObject({ type: z.literal("status"), capacity: z.number().int() });
const v1 = z.strictObject({ type: z.literal("status"), capacity: z.number().int(), labels: z.array(z.string()) });

const codecs: readonly MinorCodec<Frame>[] = [
  {
    minor: 0,
    decode: v0.transform((frame): Frame => ({ ...frame, labels: [] })),
    encode: (frame) => ({ type: frame.type, capacity: frame.capacity }),
  },
  { minor: 1, decode: v1, encode: (frame) => frame },
];

describe("createVersionedCodec", () => {
  const codec = createVersionedCodec(codecs);
  const frame: Frame = { type: "status", capacity: 2, labels: ["gpu"] };

  it("round-trips at the newest minor", () => {
    expect(codec.parse(codec.encode(frame, 1), 1)).toEqual({ ok: true, frame });
  });

  it("encodes down, and the down-encoded frame parses under the older minor", () => {
    const text = codec.encode(frame, 0);
    expect(JSON.parse(text)).toEqual({ type: "status", capacity: 2 });
    expect(codec.parse(text, 0)).toEqual({ ok: true, frame: { ...frame, labels: [] } });
  });

  it("refuses a newer field under the older minor: schemas are strict", () => {
    expect(codec.parse(codec.encode(frame, 1), 0)).toMatchObject({ ok: false, error: { reason: "invalid" } });
  });

  it("uses the nearest kept minor at or below the one asked for", () => {
    expect(codec.minors).toEqual([0, 1]);
    expect(codec.parse(codec.encode(frame, 9), 9)).toEqual({ ok: true, frame });
  });

  it("never throws on bad input", () => {
    expect(codec.parse("{not json", 1)).toMatchObject({ ok: false, error: { reason: "not-json" } });
    expect(codec.parse("x".repeat(1024 * 1024 + 1), 1)).toMatchObject({ ok: false, error: { reason: "too-large" } });
  });
});
