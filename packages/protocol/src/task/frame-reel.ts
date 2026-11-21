import { z } from "zod";

import { parseJson } from "../json.ts";
import { recordStepSchema } from "../mcp/tools.ts";
import { runnerLimits } from "../runner/limits.ts";

// A recording's frame reel (milestone 8, F-121, ADR 0068, Q312): its JPEG frames at up to
// `recordingFramesPerSecond`, their times and its steps, in one blob of at most
// `recordingMaxBytes`. The runner encodes it from the screencast; the panel's player decodes it and
// draws each frame at its time. There's no video encoder in the box, so no MP4 or WebM.
//
// The layout, all numbers big-endian:
// - 4 bytes: `OSRL`, the magic;
// - 4 bytes: the header's length, then the header's JSON (`frameReelHeaderSchema`);
// - per frame: 4 bytes of its time in ms from the reel's start, 4 bytes of its JPEG's length, the JPEG.
//
// ostra owns the format, so the header is a strict object, and the decoder refuses a reel past its
// limits, with trailing bytes, or with frames out of order. The steps are the agent's words and
// are never logged; nor is a frame.

/** The reel's first four bytes. */
export const FRAME_REEL_MAGIC = new Uint8Array([0x4f, 0x53, 0x52, 0x4c]);

/** The reel format this build writes and reads. */
export const FRAME_REEL_VERSION = 1;

/** The most frames a reel holds: its longest length at its frame rate. */
export const frameReelMaxFrames = runnerLimits.recordingMaxSeconds * runnerLimits.recordingFramesPerSecond;

/** The header's largest JSON, in bytes: the steps are its biggest part. */
const HEADER_MAX_BYTES = 256 * 1024;

/** A step as the reel records it: the step, and when it started, in ms from the reel's start. */
export const frameReelStepSchema = z.strictObject({
  step: recordStepSchema,
  atMs: z.number().int().nonnegative().max(runnerLimits.recordingMaxSeconds * 1000),
});
export type FrameReelStep = z.infer<typeof frameReelStepSchema>;

/** A reel's header: the version, the frames' size in CSS pixels, the count, the length and the steps. */
export const frameReelHeaderSchema = z
  .strictObject({
    version: z.literal(FRAME_REEL_VERSION),
    width: z.number().int().positive().max(runnerLimits.screenshotMaxWidthPx),
    height: z.number().int().positive().max(runnerLimits.screenshotMaxHeightPx),
    frameCount: z.number().int().positive().max(frameReelMaxFrames),
    durationMs: z.number().int().nonnegative().max(runnerLimits.recordingMaxSeconds * 1000),
    steps: z.array(frameReelStepSchema).max(runnerLimits.recordingStepsMax),
  })
  .describe("A frame reel's header. Its steps are never logged.");
export type FrameReelHeader = z.infer<typeof frameReelHeaderSchema>;

/** One frame: when it was captured, in ms from the reel's start, and its JPEG. */
export type FrameReelFrame = { readonly atMs: number; readonly jpeg: Uint8Array };

/** A whole reel, as the runner writes it and the player reads it. */
export type FrameReel = { readonly header: FrameReelHeader; readonly frames: readonly FrameReelFrame[] };

/** What the reel's encoder takes: the header without the count, which it counts. */
export type FrameReelInput = {
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly steps: readonly FrameReelStep[];
  readonly frames: readonly FrameReelFrame[];
};

/** Why a reel was refused: safe to log, never the reel. */
export type FrameReelRefusal =
  | "too-large"
  | "not-a-reel"
  | "truncated"
  | "bad-header"
  | "too-many-frames"
  | "frame-count-mismatch"
  | "out-of-order"
  | "not-jpeg"
  | "trailing-bytes";

export type FrameReelParse =
  | { readonly ok: true; readonly reel: FrameReel }
  | { readonly ok: false; readonly reason: FrameReelRefusal };

const isJpeg = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** A header's count alone, to tell a reel with too many frames from a bad header. */
const frameCountOnly = z.looseObject({ frameCount: z.number() });

/**
 * A reel's bytes, for its blob (`APP_RECORDING_CONTENT_TYPE`). The runner keeps within the limits
 * as it records; the decoder refuses a reel that doesn't.
 */
export const encodeFrameReel = (input: FrameReelInput): Uint8Array => {
  const header: FrameReelHeader = {
    version: FRAME_REEL_VERSION,
    width: input.width,
    height: input.height,
    frameCount: input.frames.length,
    durationMs: input.durationMs,
    steps: [...input.steps],
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const size = 8 + headerBytes.length + input.frames.reduce((total, frame) => total + 8 + frame.jpeg.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(FRAME_REEL_MAGIC, 0);
  view.setUint32(4, headerBytes.length, false);
  bytes.set(headerBytes, 8);
  let offset = 8 + headerBytes.length;
  for (const frame of input.frames) {
    view.setUint32(offset, frame.atMs, false);
    view.setUint32(offset + 4, frame.jpeg.length, false);
    bytes.set(frame.jpeg, offset + 8);
    offset += 8 + frame.jpeg.length;
  }
  return bytes;
};

/**
 * Reads a reel for the panel's player. Never throws. Refuses a reel over `recordingMaxBytes`, one
 * that isn't a reel, a header that isn't this version's strict object, more frames than
 * `frameReelMaxFrames` or than the header counts, frames out of time order or past the length, a
 * frame that isn't a JPEG, and bytes after the last frame.
 */
export const decodeFrameReel = (bytes: Uint8Array): FrameReelParse => {
  if (bytes.length > runnerLimits.recordingMaxBytes) {
    return { ok: false, reason: "too-large" };
  }
  if (bytes.length < 8 || FRAME_REEL_MAGIC.some((byte, index) => bytes[index] !== byte)) {
    return { ok: false, reason: bytes.length < 8 ? "truncated" : "not-a-reel" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4, false);
  if (headerLength > HEADER_MAX_BYTES) {
    return { ok: false, reason: "bad-header" };
  }
  if (bytes.length < 8 + headerLength) {
    return { ok: false, reason: "truncated" };
  }
  let headerText: string;
  try {
    headerText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(8, 8 + headerLength));
  } catch {
    return { ok: false, reason: "bad-header" };
  }
  const json = parseJson(headerText);
  const parsed = json.ok ? frameReelHeaderSchema.safeParse(json.value) : null;
  if (parsed?.success !== true) {
    // A count past the limit is its own refusal, so the player can say so.
    const counted = json.ok ? frameCountOnly.safeParse(json.value) : null;
    return { ok: false, reason: counted?.success === true && counted.data.frameCount > frameReelMaxFrames ? "too-many-frames" : "bad-header" };
  }
  const header = parsed.data;
  const frames: FrameReelFrame[] = [];
  let offset = 8 + headerLength;
  let previous = 0;
  while (offset < bytes.length) {
    if (frames.length >= header.frameCount) {
      return { ok: false, reason: frames.length >= frameReelMaxFrames ? "too-many-frames" : "trailing-bytes" };
    }
    if (offset + 8 > bytes.length) {
      return { ok: false, reason: "truncated" };
    }
    const atMs = view.getUint32(offset, false);
    const length = view.getUint32(offset + 4, false);
    if (offset + 8 + length > bytes.length) {
      return { ok: false, reason: "truncated" };
    }
    if (atMs < previous || atMs > header.durationMs) {
      return { ok: false, reason: "out-of-order" };
    }
    const jpeg = bytes.subarray(offset + 8, offset + 8 + length);
    if (!isJpeg(jpeg)) {
      return { ok: false, reason: "not-jpeg" };
    }
    frames.push({ atMs, jpeg });
    previous = atMs;
    offset += 8 + length;
  }
  if (frames.length !== header.frameCount) {
    return { ok: false, reason: "frame-count-mismatch" };
  }
  return { ok: true, reel: { header, frames } };
};
