import { z } from "zod";
import { CommandId, ReplicaId, RunnerId, SessionId, TaskId } from "./ids.ts";

// The runner protocol (ADR 0034), as Zod schemas both sides import.
// ostra owns this format, so every message is a strict object, except `hello`,
// which is the negotiation and tolerates unknown fields.
//
// Minors, made up for this spike so the version window has something to test:
//   minor 1: the base protocol
//   minor 2: `welcome.maxConnectionAgeMs` (down) and `status.labels` (up)
//   minor 3: `welcome.serverFeatures` (down) and `status.spoolBytes` (up)
// A peer keeps codecs for its own minor and the one before, and encodes down
// to the negotiated minor.

export const PROTOCOL_MAJOR = 1;
export const SERVER_MINOR = 2;
export const OLDEST_SHAPE = 1;
export const NEWEST_SHAPE = 3;

const int = z.number().int();
const nonNegative = int.nonnegative();
const positive = int.positive();

/** Clamp a minor to a shape this file defines. Minors 0 and 4 only ever send `hello`. */
const shape = (minor: number): 1 | 2 | 3 => (minor <= 1 ? 1 : minor >= 3 ? 3 : 2);

// ---------- down: server -> peer ----------

const welcomeBase = {
  type: z.literal("welcome"),
  minor: nonNegative,
  serverTime: z.number(),
  connectionId: z.string().min(1).max(80),
  connEpoch: positive,
  replicaId: ReplicaId,
  heartbeatMs: positive,
  creditFrames: positive,
  creditBytes: positive,
};
const welcomeV1 = z.strictObject(welcomeBase);
const welcomeV2 = z.strictObject({ ...welcomeBase, maxConnectionAgeMs: positive });
const welcomeV3 = z.strictObject({
  ...welcomeBase,
  maxConnectionAgeMs: positive,
  serverFeatures: z.array(z.string()),
});
export const WelcomeFull = z.strictObject({
  ...welcomeBase,
  maxConnectionAgeMs: positive.optional(),
  serverFeatures: z.array(z.string()).optional(),
});
export type Welcome = z.infer<typeof WelcomeFull>;

const ack = z.strictObject({
  type: z.literal("ack"),
  sessionId: SessionId,
  upTo: nonNegative,
  resendFrom: positive.optional(),
});
export type Ack = z.infer<typeof ack>;

const credit = z.strictObject({ type: z.literal("credit"), frames: positive, bytes: positive });
export type Credit = z.infer<typeof credit>;

const goaway = z.strictObject({
  type: z.literal("goaway"),
  reconnectAfterMs: nonNegative,
  reason: z.enum(["draining", "max-age", "rebalance"]),
});
export type Goaway = z.infer<typeof goaway>;

export const ErrorCode = z.enum([
  "stale-lease",
  "version-unsupported",
  "protocol-violation",
  "unauthorized",
  "replaced",
  "unknown-session",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const errorMsg = z.strictObject({
  type: z.literal("error"),
  code: ErrorCode,
  message: z.string().max(2000),
  sessionId: SessionId.optional(),
  currentEpoch: nonNegative.optional(),
  supported: z.strictObject({ min: nonNegative, max: nonNegative }).optional(),
  serverMinor: nonNegative.optional(),
});
export type ErrorMsg = z.infer<typeof errorMsg>;

const commandBase = {
  type: z.literal("command"),
  seq: positive,
  id: CommandId,
  /** Server time, in ms since the epoch. The peer judges it by the server's clock. */
  notAfter: z.number().optional(),
};
const dispatchBody = z.strictObject({ taskId: TaskId, sessionId: SessionId, leaseEpoch: positive });
const steerBody = z.strictObject({ sessionId: SessionId, text: z.string().max(65_536) });
const stopBody = z.strictObject({
  sessionId: SessionId,
  leaseEpoch: positive,
  reason: z.enum(["requested", "runner-lost"]),
});
const interruptBody = z.strictObject({ sessionId: SessionId });
const drainBody = z.strictObject({});
const updateHintBody = z.strictObject({ version: z.string().max(40) });

export const CommandBody = {
  dispatch: dispatchBody,
  steer: steerBody,
  stop: stopBody,
  interrupt: interruptBody,
  drain: drainBody,
  "update-hint": updateHintBody,
} as const;
export const CommandKind = z.enum(["dispatch", "steer", "stop", "interrupt", "drain", "update-hint"]);
export type CommandKind = z.infer<typeof CommandKind>;

const command = z.discriminatedUnion("kind", [
  z.strictObject({ ...commandBase, kind: z.literal("dispatch"), body: dispatchBody }),
  z.strictObject({ ...commandBase, kind: z.literal("steer"), body: steerBody }),
  z.strictObject({ ...commandBase, kind: z.literal("stop"), body: stopBody }),
  z.strictObject({ ...commandBase, kind: z.literal("interrupt"), body: interruptBody }),
  z.strictObject({ ...commandBase, kind: z.literal("drain"), body: drainBody }),
  z.strictObject({ ...commandBase, kind: z.literal("update-hint"), body: updateHintBody }),
]);
export const Command = command;
export type Command = z.infer<typeof command>;

const downFrames = {
  1: z.union([welcomeV1, ack, credit, goaway, errorMsg, command]),
  2: z.union([welcomeV2, ack, credit, goaway, errorMsg, command]),
  3: z.union([welcomeV3, ack, credit, goaway, errorMsg, command]),
} as const;
export const downFrame = (minor: number) => downFrames[shape(minor)];

export type DownMessage = Welcome | Ack | Credit | Goaway | ErrorMsg | Command;

/** Encode a down message for a peer at `minor`: fields that minor doesn't know are dropped. */
export const encodeDown = (msg: DownMessage, minor: number): DownMessage => {
  if (msg.type !== "welcome") return msg;
  const { maxConnectionAgeMs, serverFeatures, ...base } = msg;
  const sh = shape(minor);
  switch (sh) {
    case 1:
      return base;
    case 2:
      return { ...base, maxConnectionAgeMs: maxConnectionAgeMs ?? 3_600_000 };
    case 3:
      return {
        ...base,
        maxConnectionAgeMs: maxConnectionAgeMs ?? 3_600_000,
        serverFeatures: serverFeatures ?? [],
      };
    default:
      return sh satisfies never;
  }
};

// ---------- up: peer -> server ----------

export const HelloSession = z.looseObject({
  sessionId: SessionId,
  taskId: TaskId,
  leaseEpoch: positive,
  nextSeq: positive,
});
export type HelloSession = z.infer<typeof HelloSession>;

export const Hello = z.looseObject({
  type: z.literal("hello"),
  protocolMajor: nonNegative,
  protocolMinor: nonNegative,
  runnerVersion: z.string().max(40),
  runnerId: RunnerId,
  carrier: z.enum(["websocket", "http"]),
  lastCommandSeq: nonNegative,
  sessions: z.array(HelloSession).max(1000),
});
export type Hello = z.infer<typeof Hello>;

export const EventItem = z.strictObject({
  kind: z.enum(["text", "tool", "note"]),
  at: z.number(),
  body: z.json(),
});
export type EventItem = z.infer<typeof EventItem>;

const events = z.strictObject({
  type: z.literal("events"),
  sessionId: SessionId,
  leaseEpoch: positive,
  fromSeq: positive,
  items: z.array(EventItem).min(1).max(1000),
});
export type Events = z.infer<typeof events>;

export const CommandResult = z.enum(["accepted", "rejected", "done", "outcome-unknown"]);
export type CommandResult = z.infer<typeof CommandResult>;

const commandAck = z.strictObject({
  type: z.literal("command.ack"),
  upTo: nonNegative,
  results: z.array(
    z.strictObject({
      id: CommandId,
      seq: positive,
      result: CommandResult,
      reason: z.string().max(200).optional(),
    }),
  ),
});
export type CommandAck = z.infer<typeof commandAck>;

const statusBase = {
  type: z.literal("status"),
  capacity: nonNegative,
  running: z.array(SessionId),
};
const statusV1 = z.strictObject(statusBase);
const statusV2 = z.strictObject({ ...statusBase, labels: z.array(z.string()) });
const statusV3 = z.strictObject({ ...statusBase, labels: z.array(z.string()), spoolBytes: nonNegative });
export const StatusFull = z.strictObject({
  ...statusBase,
  labels: z.array(z.string()).optional(),
  spoolBytes: nonNegative.optional(),
});
export type Status = z.infer<typeof StatusFull>;

const upFrames = {
  1: z.union([events, commandAck, statusV1]),
  2: z.union([events, commandAck, statusV2]),
  3: z.union([events, commandAck, statusV3]),
} as const;
export const upFrame = (minor: number) => upFrames[shape(minor)];

export type UpMessage = Events | CommandAck | Status;

/** Encode an up message for a server at `minor`. */
export const encodeUp = (msg: UpMessage, minor: number): UpMessage => {
  if (msg.type !== "status") return msg;
  const { labels, spoolBytes, ...base } = msg;
  const sh = shape(minor);
  switch (sh) {
    case 1:
      return base;
    case 2:
      return { ...base, labels: labels ?? [] };
    case 3:
      return { ...base, labels: labels ?? [], spoolBytes: spoolBytes ?? 0 };
    default:
      return sh satisfies never;
  }
};

// ---------- HTTP carrier bodies ----------

export const httpUpBody = (minor: number) =>
  z.strictObject({ conn: positive, messages: z.array(upFrame(minor)).max(512) });
export const httpDownBody = (minor: number) => z.strictObject({ messages: z.array(downFrame(minor)) });

export const InfoBody = z.strictObject({
  protocolMajor: nonNegative,
  serverMinor: nonNegative,
  supported: z.strictObject({ min: nonNegative, max: nonNegative }),
  serverVersion: z.string(),
});

// ---------- versions ----------

export type Negotiation = { ok: true; minor: number } | { ok: false; min: number; max: number };

/** The server accepts a peer one minor behind or ahead (ADR 0034). */
export const negotiate = (serverMinor: number, peerMajor: number, peerMinor: number): Negotiation => {
  const min = Math.max(0, serverMinor - 1);
  const max = serverMinor + 1;
  if (peerMajor !== PROTOCOL_MAJOR || peerMinor < min || peerMinor > max) return { ok: false, min, max };
  return { ok: true, minor: Math.min(serverMinor, peerMinor) };
};

// ---------- close codes ----------

export const CloseCode = {
  protocolViolation: 4400,
  tokenExpired: 4401,
  revoked: 4403,
  replaced: 4409,
  upgradeRequired: 4426,
  draining: 4503,
} as const;

/** Parse JSON text without throwing. */
export const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
};

/** A WebSocket frame's bytes as text. */
export const frameText = (data: Buffer | ArrayBuffer | Buffer[]): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
};
