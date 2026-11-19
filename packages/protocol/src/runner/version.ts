import type { z } from "zod";

import { describeIssues, parseJson, utf8ByteLength } from "../json.ts";
import { runnerLimits } from "./limits.ts";

// Versions of the runner protocol (ADR 0034, ADR 0022, F-061). Ported from
// spikes/runner-transport/src/protocol/messages.ts ("versions" and the codec per minor).
//
// - The URL carries the major: `/runner/v1/*`.
// - `hello` and `welcome` negotiate the minor. The server accepts a peer one minor behind or
//   ahead, and both sides speak the lower of the two.
// - Each side keeps a codec for its own minor and the one before, and encodes down to the
//   negotiated minor, because every message but `hello` refuses unknown fields.

/** The protocol's major version, in the URL. */
export const PROTOCOL_MAJOR = 1;

/**
 * This build's minor. Milestone 1 shipped minor 0. Milestone 2 ships minor 1: sessions across
 * turns, the bulk path, the `release` command, restores and limits. A minor-0 peer still works
 * inside the window: it's never sent `release` or the new spec fields, and it sends no new event.
 */
export const PROTOCOL_MINOR = 1;

/** The URL prefix of every runner endpoint. */
export const RUNNER_PATH_PREFIX = `/runner/v${String(PROTOCOL_MAJOR)}`;

/** The minors a server at `serverMinor` accepts: one behind to one ahead. */
export type MinorWindow = { readonly min: number; readonly max: number };

export const minorWindow = (serverMinor: number): MinorWindow => ({
  min: Math.max(0, serverMinor - 1),
  max: serverMinor + 1,
});

export type Negotiation =
  | { readonly ok: true; readonly minor: number }
  | { readonly ok: false; readonly reason: "major" | "minor"; readonly window: MinorWindow };

/** The server's answer to a peer's `hello` versions (ADR 0034). */
export const negotiate = (serverMinor: number, peerMajor: number, peerMinor: number): Negotiation => {
  const window = minorWindow(serverMinor);
  if (peerMajor !== PROTOCOL_MAJOR) {
    return { ok: false, reason: "major", window };
  }
  if (!Number.isInteger(peerMinor) || peerMinor < window.min || peerMinor > window.max) {
    return { ok: false, reason: "minor", window };
  }
  return { ok: true, minor: Math.min(serverMinor, peerMinor) };
};

// ---------- codecs ----------

/**
 * One minor's shape of a frame set. `decode` validates a frame written in that minor and lifts it
 * to the current type. `encode` writes a current frame in that minor's shape, dropping or filling
 * the fields that minor doesn't know.
 */
export type MinorCodec<Frame> = {
  readonly minor: number;
  readonly decode: z.ZodType<Frame>;
  readonly encode: (frame: Frame) => unknown;
};

export type FrameParseError = {
  /** `too-large`: over the frame cap. `not-json`: not JSON text. `invalid`: JSON, but not a frame. */
  readonly reason: "too-large" | "not-json" | "invalid";
  /** Paths and rules only, never values: safe to log. */
  readonly detail: string;
};

export type FrameParse<Frame> =
  | { readonly ok: true; readonly frame: Frame }
  | { readonly ok: false; readonly error: FrameParseError };

export type VersionedCodec<Frame> = {
  /** The minors this codec set can read and write, oldest first. */
  readonly minors: readonly number[];
  /** Parses one frame's text written at `minor`. Never throws. */
  readonly parse: (text: string, minor: number) => FrameParse<Frame>;
  /** Parses an already-decoded JSON value written at `minor` (the HTTP carrier's arrays). */
  readonly parseValue: (value: unknown, minor: number) => FrameParse<Frame>;
  /** A current frame as the JSON value a peer at `minor` reads. */
  readonly encodeValue: (frame: Frame, minor: number) => unknown;
  /** A current frame as the text a peer at `minor` reads. */
  readonly encode: (frame: Frame, minor: number) => string;
};

/**
 * Builds a codec set from one codec per kept minor. A minor between two kept ones uses the newest
 * codec at or below it; a minor below the oldest uses the oldest.
 */
export const createVersionedCodec = <Frame>(
  codecs: readonly MinorCodec<Frame>[],
): VersionedCodec<Frame> => {
  const sorted = [...codecs].sort((a, b) => a.minor - b.minor);
  const oldest = sorted[0];
  if (oldest === undefined) {
    throw new Error("a versioned codec needs at least one minor");
  }
  const codecFor = (minor: number): MinorCodec<Frame> => {
    let chosen = oldest;
    for (const codec of sorted) {
      if (codec.minor <= minor) {
        chosen = codec;
      }
    }
    return chosen;
  };
  const parseValue = (value: unknown, minor: number): FrameParse<Frame> => {
    const result = codecFor(minor).decode.safeParse(value);
    return result.success
      ? { ok: true, frame: result.data }
      : { ok: false, error: { reason: "invalid", detail: describeIssues(result.error) } };
  };
  const encodeValue = (frame: Frame, minor: number): unknown => codecFor(minor).encode(frame);
  return {
    minors: sorted.map((codec) => codec.minor),
    parse: (text, minor) => {
      const bytes = utf8ByteLength(text);
      if (bytes > runnerLimits.frameMaxBytes) {
        return {
          ok: false,
          error: { reason: "too-large", detail: `${String(bytes)} bytes, over ${String(runnerLimits.frameMaxBytes)}` },
        };
      }
      const json = parseJson(text);
      if (!json.ok) {
        return { ok: false, error: { reason: "not-json", detail: "the frame is not JSON" } };
      }
      return parseValue(json.value, minor);
    },
    parseValue,
    encodeValue,
    encode: (frame, minor) => JSON.stringify(encodeValue(frame, minor)),
  };
};
