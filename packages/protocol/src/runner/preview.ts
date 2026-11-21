import { z } from "zod";

import { previewViewIdSchema } from "../ids.ts";
import { epochMsSchema, leaseEpochSchema } from "../common.ts";
import { parseJson } from "../json.ts";
import { appPathSchema, previewViewportSchema } from "../task/app.ts";
import { runnerLimits } from "./limits.ts";
import { RUNNER_PATH_PREFIX } from "./version.ts";

// The preview connection (milestone 8, protocol minor 7, ADR 0068 amending ADR 0034): a second
// connection a box opens only while someone views one of its previews, so a preview's bytes never
// ride the session. `GET /runner/v1/preview?view=<viewId>&leaseEpoch=<n>` upgrades to a binary
// WebSocket, authenticated with the box's task token (on `host`, the runner's access token) and
// the lease epoch, so a stale epoch is refused as an event is. Its messages carry binary, never
// JSON in base64.
//
// - `stream` (the browser view, F-141): JPEG frames up; viewport, navigation and input down; acks
//   both ways. Each message is a 1-byte type and its payload (`encodePreviewMessage`).
// - `tunnel` (`ostra preview` and the native preview, F-143, F-144): the messages are one HTTP/2
//   connection's bytes, with core as the client and the box as the server (`previewTunnel`).
//
// ostra owns the format, so every JSON part is a strict object. A typed text, a path and a frame
// are never logged.

/** A view's mode on the preview connection. */
export const previewModeSchema = z.enum(["stream", "tunnel"]);
export type PreviewMode = z.infer<typeof previewModeSchema>;

/** The preview connection's paths. */
export const previewPaths = {
  /** `GET`, upgraded to a WebSocket: one view's connection, `?view=&leaseEpoch=`. */
  connection: `${RUNNER_PATH_PREFIX}/preview`,
  /** `POST`, the HTTP carrier's frames for a view (Q306): a multipart body (`previewFramesBodySchema`). */
  frames: `${RUNNER_PATH_PREFIX}/preview/frames`,
} as const;

/** The connection's query: the view and the lease epoch it was opened under. */
export const previewConnectionQuerySchema = z.strictObject({
  view: previewViewIdSchema,
  leaseEpoch: z.coerce.number().pipe(leaseEpochSchema),
});
export type PreviewConnectionQuery = z.infer<typeof previewConnectionQuerySchema>;

/** The WebSocket subprotocol of each mode: the box asks for one, and core answers with it or refuses. */
export const previewSubprotocols = {
  stream: "ostra-preview-stream.v1",
  tunnel: "ostra-preview-tunnel.v1",
} as const satisfies Readonly<Record<PreviewMode, string>>;

// ---------- a member's input (F-141) ----------

/** The modifier keys held, as DevTools counts them: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiersSchema = z.number().int().min(0).max(15);
/** A point on the page, in CSS pixels. */
const coordinateSchema = z.number().min(0).max(10_000);
/** A wheel's movement, in CSS pixels. */
const wheelDeltaSchema = z.number().min(-10_000).max(10_000);

/**
 * One input event for a view's page, which the box passes on as DevTools'
 * `Input.dispatchMouseEvent`, `dispatchKeyEvent` or `insertText`. Pasting text works; files and the
 * member's clipboard don't. Typed text is never logged.
 */
export const previewInputEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: coordinateSchema,
    y: coordinateSchema,
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(0).max(3),
    modifiers: modifiersSchema,
  }),
  z.strictObject({
    kind: z.literal("wheel"),
    x: coordinateSchema,
    y: coordinateSchema,
    deltaX: wheelDeltaSchema,
    deltaY: wheelDeltaSchema,
    modifiers: modifiersSchema,
  }),
  z.strictObject({
    kind: z.literal("key"),
    action: z.enum(["down", "up"]),
    /** The key's value, as the DOM's `KeyboardEvent.key` names it. */
    key: z.string().min(1).max(64),
    /** The physical key, as `KeyboardEvent.code` names it. */
    code: z.string().max(64),
    modifiers: modifiersSchema,
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(runnerLimits.previewInputTextMaxChars) }),
]);
export type PreviewInputEvent = z.infer<typeof previewInputEventSchema>;

/** A batch of input, in order. Typed text is never logged. */
export const previewInputEventsSchema = z
  .array(previewInputEventSchema)
  .min(1)
  .max(runnerLimits.previewInputEventsMax)
  .describe("A member's input. Typed text is never logged.");

// ---------- the `stream` mode's messages ----------

/** Each message's first byte. */
export const previewMessageTypeBytes = { frame: 1, control: 2, ack: 3, close: 4 } as const;
export type PreviewMessageType = keyof typeof previewMessageTypeBytes;

const sequenceSchema = z.number().int().positive();

/**
 * A frame's header, before its JPEG: the frame's number in the view, when the box captured it, and
 * its size in device pixels.
 */
export const previewFrameHeaderSchema = z.strictObject({
  seq: sequenceSchema,
  at: epochMsSchema,
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
});
export type PreviewFrameHeader = z.infer<typeof previewFrameHeaderSchema>;

/**
 * Core's instruction for the view's page, numbered so the box acks it: a new viewport, a path to
 * open, a reload, or a batch of input. A path and typed text are never logged.
 */
export const previewControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("viewport"), seq: sequenceSchema, viewport: previewViewportSchema }),
  z.strictObject({ kind: z.literal("navigate"), seq: sequenceSchema, path: appPathSchema }),
  z.strictObject({ kind: z.literal("reload"), seq: sequenceSchema }),
  z.strictObject({ kind: z.literal("input"), seq: sequenceSchema, events: previewInputEventsSchema }),
]);
export type PreviewControl = z.infer<typeof previewControlSchema>;

/**
 * An ack, both ways: core acks each frame it took, which is the screencast's back-pressure
 * (`browserViewFramesInFlight`); the box acks each control it applied.
 */
export const previewAckSchema = z.strictObject({ seq: sequenceSchema });
export type PreviewAck = z.infer<typeof previewAckSchema>;

/** Why a view's connection ends, from either side. */
export const previewCloseReasonSchema = z.enum([
  /** The view was closed (`preview.close`), or its last watcher left. */
  "closed",
  /** The page crashed. A new view opens a new page. */
  "page-crashed",
  /** The app process behind the preview exited or was stopped. */
  "app-stopped",
  /** The box is stopping. */
  "box-stopping",
  /** The lease moved on: a newer box holds the task. */
  "stale-lease",
  /** A message didn't parse, or broke a limit. */
  "protocol-violation",
]);
export type PreviewCloseReason = z.infer<typeof previewCloseReasonSchema>;

export const previewCloseSchema = z.strictObject({ reason: previewCloseReasonSchema });
export type PreviewClose = z.infer<typeof previewCloseSchema>;

/** One message of the `stream` mode. */
export type PreviewMessage =
  | { readonly type: "frame"; readonly header: PreviewFrameHeader; readonly jpeg: Uint8Array }
  | { readonly type: "control"; readonly control: PreviewControl }
  | { readonly type: "ack"; readonly ack: PreviewAck }
  | { readonly type: "close"; readonly close: PreviewClose };

/** The largest message either side sends or accepts: a frame's type, header length, header and JPEG. */
export const previewMessageMaxBytes = 1 + 4 + runnerLimits.previewJsonMaxBytes + runnerLimits.previewFrameMaxBytes;

/** Why a message was refused: safe to log, never the message. */
export type PreviewMessageRefusal = "empty" | "too-large" | "unknown-type" | "truncated" | "not-json" | "invalid" | "not-jpeg";

export type PreviewMessageParse =
  | { readonly ok: true; readonly message: PreviewMessage }
  | { readonly ok: false; readonly reason: PreviewMessageRefusal };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** A JPEG starts with its SOI marker. */
const isJpeg = (bytes: Uint8Array): boolean => bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

const jsonPayload = (value: unknown): Uint8Array => textEncoder.encode(JSON.stringify(value));

const withType = (type: PreviewMessageType, payload: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(1 + payload.length);
  bytes[0] = previewMessageTypeBytes[type];
  bytes.set(payload, 1);
  return bytes;
};

/**
 * One message as the bytes of one binary WebSocket message. A frame is its type, its header's
 * length as a big-endian 32-bit number, the header's JSON and the JPEG; the others are their type
 * and their JSON. The sender keeps within the limits; the reader refuses what doesn't
 * (`decodePreviewMessage`).
 */
export const encodePreviewMessage = (message: PreviewMessage): Uint8Array => {
  switch (message.type) {
    case "frame": {
      const header = jsonPayload(message.header);
      const bytes = new Uint8Array(1 + 4 + header.length + message.jpeg.length);
      bytes[0] = previewMessageTypeBytes.frame;
      new DataView(bytes.buffer).setUint32(1, header.length, false);
      bytes.set(header, 5);
      bytes.set(message.jpeg, 5 + header.length);
      return bytes;
    }
    case "control":
      return withType("control", jsonPayload(message.control));
    case "ack":
      return withType("ack", jsonPayload(message.ack));
    case "close":
      return withType("close", jsonPayload(message.close));
    default:
      return message satisfies never;
  }
};

/** A JSON part's value, or why it was refused. */
const readJson = (bytes: Uint8Array): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: PreviewMessageRefusal } => {
  if (bytes.length > runnerLimits.previewJsonMaxBytes) {
    return { ok: false, reason: "too-large" };
  }
  if (bytes.length === 0) {
    return { ok: false, reason: "truncated" };
  }
  let text: string;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  const json = parseJson(text);
  return json.ok ? { ok: true, value: json.value } : { ok: false, reason: "not-json" };
};

/** One JSON message's schema, by its type. */
const jsonMessage = <T,>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
  wrap: (value: T) => PreviewMessage,
): PreviewMessageParse => {
  const json = readJson(bytes);
  if (!json.ok) {
    return json;
  }
  const parsed = schema.safeParse(json.value);
  return parsed.success ? { ok: true, message: wrap(parsed.data) } : { ok: false, reason: "invalid" };
};

/**
 * Reads one binary message of the `stream` mode. Never throws. Refuses an empty, oversized or
 * truncated message, an unknown type, a JSON part that isn't one of ostra's strict objects, and a
 * frame that isn't a JPEG.
 */
export const decodePreviewMessage = (bytes: Uint8Array): PreviewMessageParse => {
  if (bytes.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (bytes.length > previewMessageMaxBytes) {
    return { ok: false, reason: "too-large" };
  }
  const payload = bytes.subarray(1);
  switch (bytes[0] ?? 0) {
    case previewMessageTypeBytes.frame: {
      if (payload.length < 4) {
        return { ok: false, reason: "truncated" };
      }
      const headerLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
      if (headerLength > runnerLimits.previewJsonMaxBytes) {
        return { ok: false, reason: "too-large" };
      }
      if (payload.length < 4 + headerLength) {
        return { ok: false, reason: "truncated" };
      }
      const jpeg = payload.subarray(4 + headerLength);
      if (jpeg.length === 0) {
        return { ok: false, reason: "truncated" };
      }
      if (jpeg.length > runnerLimits.previewFrameMaxBytes) {
        return { ok: false, reason: "too-large" };
      }
      if (!isJpeg(jpeg)) {
        return { ok: false, reason: "not-jpeg" };
      }
      return jsonMessage(payload.subarray(4, 4 + headerLength), previewFrameHeaderSchema, (header) => ({
        type: "frame",
        header,
        jpeg: jpeg.slice(),
      }));
    }
    case previewMessageTypeBytes.control:
      return jsonMessage(payload, previewControlSchema, (control) => ({ type: "control", control }));
    case previewMessageTypeBytes.ack:
      return jsonMessage(payload, previewAckSchema, (ack) => ({ type: "ack", ack }));
    case previewMessageTypeBytes.close:
      return jsonMessage(payload, previewCloseSchema, (close) => ({ type: "close", close }));
    default:
      return { ok: false, reason: "unknown-type" };
  }
};

// ---------- the `tunnel` mode ----------

/**
 * The `tunnel` mode (F-143, F-144, ADR 0068): every binary message is the next bytes of one
 * HTTP/2 connection (RFC 9113) over the WebSocket's duplex stream, from Node's own `http2`. Core
 * is the client and the box (the sidecar, or the runner on `host`) is the server, which dials
 * `localhost:<port>` over IPv6 and IPv4 (on `docker`, through the init's forwarder; spike 08 found
 * Vite on `::1` only) only for a port `mayReach` allows. HTTP/2's per-stream windows and the
 * WebSocket's `bufferedAmount` are the back-pressure. Core opens the box's HTTP/2 session once
 * the box's SETTINGS arrive, keeps it while the view lives, and closes it with the view.
 *
 * - A native preview's request is an HTTP/2 request whose `:authority` is `localhost:<port>`.
 * - A browser's WebSocket is an extended CONNECT (RFC 8441) with `:protocol` `websocket`.
 * - An `ostra preview` connection is a plain `CONNECT` to `localhost:<port>`: raw bytes.
 *
 * The HTTP fallback carrier has no tunnel (Q306): `isPreviewable` says so.
 */
export const previewTunnel = {
  protocol: "h2",
  client: "core",
  server: "box",
  /** The `:authority` a request or a `CONNECT` names: the app's port on the box's loopback. */
  authority: (port: number): string => `localhost:${String(port)}`,
  /**
   * The largest WebSocket message either side of a tunnel accepts: one write of HTTP/2 frames,
   * which Node keeps far below this *(working value)*. The CLI's tunnel to core takes the same.
   */
  messageMaxBytes: 16 * 1024 * 1024,
} as const;

// ---------- the HTTP carrier's frames (Q306) ----------

/** The multipart part that holds the body's JSON; each frame's JPEG is the part its `part` names. */
export const PREVIEW_FRAMES_BODY_PART = "body";

/** The part a frame's JPEG travels in. */
export const previewFramesPartName = (index: number): string => `frame-${String(index)}`;

/**
 * `POST /runner/v1/preview/frames`: a view's frames over the HTTP carrier, at most
 * `httpCarrierFramesPerSecond` a second, as a multipart body. The `body` part is this JSON; each
 * frame's JPEG is a part of its own. Input for the view comes down the long poll as
 * `preview.input` commands. The frames are never logged.
 */
export const previewFramesBodySchema = z.strictObject({
  viewId: previewViewIdSchema,
  leaseEpoch: leaseEpochSchema,
  frames: z
    .array(
      z.strictObject({
        seq: sequenceSchema,
        at: epochMsSchema,
        width: z.number().int().min(1).max(8192),
        height: z.number().int().min(1).max(8192),
        part: z.string().regex(/^frame-\d$/, "a frame's part"),
      }),
    )
    .min(1)
    .max(runnerLimits.httpCarrierFramesPerSecond),
});
export type PreviewFramesBody = z.infer<typeof previewFramesBodySchema>;

/** The frames' answer: the highest frame core took, or why it took none. */
export const previewFramesResponseSchema = z.union([
  z.strictObject({ ackedUpTo: sequenceSchema }),
  z.strictObject({ code: z.enum(["view-closed", "stale-lease", "too-fast", "invalid"]) }),
]);
export type PreviewFramesResponse = z.infer<typeof previewFramesResponseSchema>;

// ---------- what a runner can preview (`hello`, `status`) ----------

/** What a runner reports it can do for a preview (minor 7): the browser view and the tunnel. */
export const previewSupportSchema = z.strictObject({
  stream: z.boolean(),
  /** Always `false` on the HTTP carrier. */
  tunnel: z.boolean(),
});
export type PreviewSupport = z.infer<typeof previewSupportSchema>;

/** The carrier a runner reaches core over (ADR 0034). */
export type PreviewCarrier = "websocket" | "http";

/** Why no view of a task's preview can open: the reason the pane shows (`previewRefusalWords`). */
export const previewRefusalReasonSchema = z.enum([
  /** The runner speaks a minor below 7. */
  "runner-needs-upgrade",
  /**
   * The runner reports neither the browser view nor the tunnel: no browser and the HTTP carrier, or
   * a runner that reports nothing of it.
   */
  "runner-cannot-preview",
]);
export type PreviewRefusalReason = z.infer<typeof previewRefusalReasonSchema>;

export type Previewability =
  | {
      readonly previewable: true;
      /** The browser view. */
      readonly stream: boolean;
      /** `ostra preview` and the native preview: never on the HTTP carrier. */
      readonly tunnel: boolean;
      /** The browser view's frames a second on this carrier. */
      readonly framesPerSecond: number;
    }
  | { readonly previewable: false; readonly reason: PreviewRefusalReason };

/**
 * What a runner at `peerMinor` on `carrier` can show of a task's previews (ADR 0068): nothing
 * below minor 7; no tunnel on the HTTP carrier; and the browser view at
 * `httpCarrierFramesPerSecond` there. `reported` is what the runner said in `hello` or `status`.
 * It fails closed: a runner that reported nothing gets no view.
 */
export const isPreviewable = (peerMinor: number, carrier: PreviewCarrier, reported: PreviewSupport | null | undefined): Previewability => {
  if (peerMinor < 7) {
    return { previewable: false, reason: "runner-needs-upgrade" };
  }
  const stream = reported?.stream ?? false;
  const tunnel = carrier === "websocket" && (reported?.tunnel ?? false);
  if (!stream && !tunnel) {
    return { previewable: false, reason: "runner-cannot-preview" };
  }
  const framesPerSecond = carrier === "http" ? runnerLimits.httpCarrierFramesPerSecond : runnerLimits.browserViewFramesPerSecond;
  return { previewable: true, stream, tunnel, framesPerSecond };
};

/** The pane's words for a refusal. Never task content. */
export const previewRefusalWords = (reason: PreviewRefusalReason): string => {
  switch (reason) {
    case "runner-needs-upgrade":
      return "This task's runner needs protocol 1.7 or later to show its app: update the runner.";
    case "runner-cannot-preview":
      return "This task's runner can't show its app: it reports neither a browser in its box nor a tunnel to the server.";
    default:
      return reason satisfies never;
  }
};

// ---------- the panel's stream (core → the web app → the pane, F-141) ----------

/**
 * The body of core's `GET /panel/v1/previews/:viewId/stream`, which the web app relays as it is
 * (ADR 0068, "The bytes stay off the session"): a run of records, each a 4-byte big-endian length
 * and one `stream` mode message (`encodePreviewMessage`). Core sends the box's `frame` messages, the
 * newest first when a stream joins, and a `close` before it ends the response. The pane reads them
 * with `createPanelStreamReader`. A frame is never logged.
 */
export const encodePanelStreamRecord = (message: PreviewMessage): Uint8Array => {
  const body = encodePreviewMessage(message);
  const record = new Uint8Array(4 + body.length);
  new DataView(record.buffer).setUint32(0, body.length, false);
  record.set(body, 4);
  return record;
};

/** Reads the panel's stream as its chunks arrive, however the network split them. */
export type PanelStreamReader = {
  /** The records `chunk` completed, in order, each decoded or refused. A refused record ends the stream for its reader. */
  readonly push: (chunk: Uint8Array) => readonly PreviewMessageParse[];
  /** Bytes held for a record not yet complete. */
  readonly pending: () => number;
};

export const createPanelStreamReader = (): PanelStreamReader => {
  let held = new Uint8Array(0);
  return {
    push: (chunk) => {
      const joined = new Uint8Array(held.length + chunk.length);
      joined.set(held, 0);
      joined.set(chunk, held.length);
      const out: PreviewMessageParse[] = [];
      let offset = 0;
      while (joined.length - offset >= 4) {
        const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0, false);
        if (length > previewMessageMaxBytes) {
          out.push({ ok: false, reason: "too-large" });
          held = new Uint8Array(0);
          return out;
        }
        if (joined.length - offset - 4 < length) {
          break;
        }
        out.push(decodePreviewMessage(joined.subarray(offset + 4, offset + 4 + length)));
        offset += 4 + length;
      }
      held = joined.slice(offset);
      return out;
    },
    pending: () => held.length,
  };
};

/** `POST /panel/v1/previews/:viewId/input`: a batch of a viewer's input, in order. Typed text is never logged. */
export const panelPreviewInputBodySchema = z.strictObject({ events: previewInputEventsSchema });
export type PanelPreviewInputBody = z.infer<typeof panelPreviewInputBodySchema>;
