import { z } from "zod";

// The preview connection's stream mode (milestone 8's spec, section 5.1): each WebSocket message is a 1-byte
// type and its payload. A frame is a JSON header and the JPEG; control, ack and close are JSON. ostra owns the
// format, so every JSON part is a strict object.

export const messageType = { frame: 1, control: 2, ack: 3, close: 4 } as const;

const modifiers = z.number().int().min(0).max(15);
const coordinate = z.number().min(0).max(20_000);

export const inputEventSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("mouse"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
    x: coordinate,
    y: coordinate,
    button: z.enum(["none", "left", "middle", "right"]),
    buttons: z.number().int().min(0).max(31),
    clickCount: z.number().int().min(0).max(3),
    modifiers,
  }),
  z.strictObject({ t: z.literal("wheel"), x: coordinate, y: coordinate, deltaX: z.number(), deltaY: z.number(), modifiers }),
  z.strictObject({
    t: z.literal("key"),
    type: z.enum(["keyDown", "keyUp"]),
    key: z.string().max(32),
    code: z.string().max(32),
    keyCode: z.number().int().min(0).max(255),
    text: z.string().max(4).optional(),
    modifiers,
    repeat: z.boolean(),
  }),
  z.strictObject({ t: z.literal("text"), text: z.string().max(65_536) }),
]);
export type InputEvent = z.infer<typeof inputEventSchema>;

export const inputBatchSchema = z.strictObject({ events: z.array(inputEventSchema).min(1).max(200) });

export const controlSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("viewers"), count: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal("viewport"), width: z.number().int().min(200).max(1920), height: z.number().int().min(200).max(4000), mobile: z.boolean() }),
  z.strictObject({ kind: z.literal("navigate"), url: z.string().max(2048) }),
  z.strictObject({ kind: z.literal("reload") }),
  z.strictObject({ kind: z.literal("input"), events: z.array(inputEventSchema).min(1).max(200) }),
]);
export type Control = z.infer<typeof controlSchema>;

export const frameHeaderSchema = z.strictObject({
  seq: z.number().int().min(0),
  at: z.number(),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type FrameHeader = z.infer<typeof frameHeaderSchema>;

export const ackSchema = z.strictObject({ seq: z.number().int().min(0) });
export const closeSchema = z.strictObject({ reason: z.string().max(200) });

export type WireMessage =
  | { readonly type: "frame"; readonly header: FrameHeader; readonly jpeg: Buffer }
  | { readonly type: "control"; readonly control: Control }
  | { readonly type: "ack"; readonly seq: number }
  | { readonly type: "close"; readonly reason: string };

export const encodeFrame = (header: FrameHeader, jpeg: Buffer): Buffer => {
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(5);
  head.writeUInt8(messageType.frame, 0);
  head.writeUInt32BE(json.length, 1);
  return Buffer.concat([head, json, jpeg]);
};

const encodeJson = (type: number, value: unknown): Buffer => Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(value))]);
export const encodeControl = (control: Control): Buffer => encodeJson(messageType.control, control);
export const encodeAck = (seq: number): Buffer => encodeJson(messageType.ack, { seq });
export const encodeClose = (reason: string): Buffer => encodeJson(messageType.close, { reason });

export const decodeMessage = (data: Buffer): WireMessage => {
  const type = data.readUInt8(0);
  if (type === messageType.frame) {
    const length = data.readUInt32BE(1);
    const header = frameHeaderSchema.parse(JSON.parse(data.subarray(5, 5 + length).toString("utf8")));
    return { type: "frame", header, jpeg: data.subarray(5 + length) };
  }
  const json: unknown = JSON.parse(data.subarray(1).toString("utf8"));
  if (type === messageType.control) return { type: "control", control: controlSchema.parse(json) };
  if (type === messageType.ack) return { type: "ack", seq: ackSchema.parse(json).seq };
  if (type === messageType.close) return { type: "close", reason: closeSchema.parse(json).reason };
  throw new Error(`unknown message type ${String(type)}`);
};

// The member's stream: length-prefixed records, read with fetch's body reader. Each record is a u32 length,
// a u16 header length, the header's JSON and the JPEG.
export const encodeRecord = (header: FrameHeader, jpeg: Buffer): Buffer => {
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(6);
  head.writeUInt32BE(2 + json.length + jpeg.length, 0);
  head.writeUInt16BE(json.length, 4);
  return Buffer.concat([head, json, jpeg]);
};

// The HTTP carrier: frames go up in multipart POSTs, at most 2 frames a second for a view, and control comes
// down a 25 s long poll (ADR 0068, "The HTTP fallback carrier").
export const httpFramesMetaSchema = z.strictObject({ viewId: z.string().max(64), frames: z.array(frameHeaderSchema).min(1).max(4) });
export const httpDownSchema = z.strictObject({ controls: z.array(controlSchema) });
