import { z } from "zod";

import { commandIdSchema, replicaIdSchema, sessionIdSchema, taskIdSchema } from "../ids.ts";
import {
  commandSeqSchema,
  epochMsSchema,
  executorKindSchema,
  leaseEpochSchema,
  runnerLabelSchema,
  sessionSeqSchema,
} from "../common.ts";
import { runnerEventSchema } from "../events/agent-events.ts";
import { liveTextFrameSchema } from "../events/live-text.ts";
import { commandResultSchema, commandSchema } from "./commands.ts";
import { runnerLimits } from "./limits.ts";
import { peerSchema } from "./peer.ts";
import { createVersionedCodec, PROTOCOL_MINOR } from "./version.ts";
import type { FrameParse } from "./version.ts";

// The runner protocol's frames (ADR 0034): one JSON envelope per WebSocket text frame,
// discriminated on `type`. ostra owns the format, so every frame is a strict object except
// `hello`, the negotiation, which tolerates unknown fields. Ported from
// spikes/runner-transport/src/protocol/messages.ts.
//
// Minor 0 is the only shape so far. When minor 1 adds a field, minor 0's codec stays beside it:
// its `decode` lifts a minor-0 frame to the current type and its `encode` drops the new field.

const count = z.number().int().nonnegative();
const positive = z.number().int().positive();

// ---------- up: peer to server ----------

/** A session the peer still holds, reported in `hello` so the server knows where to resume. */
export const helloSessionSchema = z.looseObject({
  taskId: taskIdSchema,
  sessionId: sessionIdSchema,
  leaseEpoch: leaseEpochSchema,
  /** The next session number the peer will send: everything below it is spooled or acked. */
  nextSessionSeq: positive,
});
export type HelloSession = z.infer<typeof helloSessionSchema>;

/**
 * The first frame a peer sends. Its versions are negotiated (`negotiate`), and its peer identity
 * must match the access token it connected with. The one loose message: a newer peer may add
 * fields an older server ignores.
 */
export const helloSchema = z.looseObject({
  type: z.literal("hello"),
  protocolMajor: count,
  protocolMinor: count,
  /** The `ostra` CLI's version. */
  runnerVersion: z.string().min(1).max(64),
  peer: peerSchema,
  carrier: z.enum(["websocket", "http"]),
  /** The highest command `seq` the peer applied, so the server resends from the one after. */
  lastCommandSeq: count,
  sessions: z.array(helloSessionSchema).max(runnerLimits.helloSessionsMax),
});
export type Hello = z.infer<typeof helloSchema>;

/**
 * A batch of events, in session order per session. The server saves the batch in one transaction,
 * idempotent on `(sessionId, sessionSeq)`, and acks each session after the commit.
 *
 * Late events are refused: a batch whose lease epoch is stale, because the task grace ended or a
 * newer dispatch raised it, gets `error { code: "stale-lease", currentEpoch }`. It's never kept in
 * a quarantine (ADR 0034, Q111). The peer then discards that session's spool.
 */
export const eventsFrameSchema = z.strictObject({
  type: z.literal("events"),
  events: z.array(runnerEventSchema).min(1).max(runnerLimits.eventsPerFrameMax),
});
export type EventsFrame = z.infer<typeof eventsFrameSchema>;

export const commandAckItemSchema = z.strictObject({
  id: commandIdSchema,
  seq: commandSeqSchema,
  result: commandResultSchema,
  /** A short machine-readable reason, never content: `past-not-after`, `stale-lease`, `no-capacity`. */
  reason: z.string().max(200).optional(),
});
export type CommandAckItem = z.infer<typeof commandAckItemSchema>;

/** The peer's results for commands, and the highest contiguous `seq` it applied. */
export const commandAckSchema = z.strictObject({
  type: z.literal("command-ack"),
  upTo: count,
  results: z.array(commandAckItemSchema).max(runnerLimits.ackResultsMax),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

/** What the peer can take, sent after `welcome` and whenever it changes (F-013, F-067). */
export const statusSchema = z.strictObject({
  type: z.literal("status"),
  executor: executorKindSchema,
  /** How many tasks the peer runs at once. A sidecar reports 1. */
  capacity: count,
  freeSlots: count,
  labels: z.array(runnerLabelSchema).max(64),
  /** The `ostra` CLI's version. */
  version: z.string().min(1).max(64),
  /** The sessions running now. */
  running: z.array(sessionIdSchema).max(runnerLimits.helloSessionsMax),
  /** Bytes in the disk spool not yet acked. */
  spoolBytes: count,
});
export type Status = z.infer<typeof statusSchema>;

/** Partial text: unsequenced, never spooled, never acked (ADR 0035). */
export const liveTextSchema = z.strictObject({
  type: z.literal("live-text"),
  frames: z.array(liveTextFrameSchema).min(1).max(runnerLimits.liveTextPerFrameMax),
});
export type LiveText = z.infer<typeof liveTextSchema>;

const upFrameV0 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchema,
  commandAckSchema,
  statusSchema,
  liveTextSchema,
]);
export type UpFrame = z.infer<typeof upFrameV0>;
export type UpFrameType = UpFrame["type"];

// ---------- down: server to peer ----------

/** The server's answer to `hello`: the negotiated minor, its clock and the credit window. */
export const welcomeSchema = z.strictObject({
  type: z.literal("welcome"),
  /** The negotiated minor: both sides speak it from here on. */
  minor: count,
  /** The server's clock, in ms since the epoch: the peer judges `notAfter` by it. */
  serverTime: epochMsSchema,
  /** Raised by every new connection of this peer; an older one is evicted with `4409`. */
  connectionEpoch: positive,
  replicaId: replicaIdSchema,
  pingMs: positive,
  /** The credit window: the peer has at most this many frames and bytes unacked. */
  creditFrames: positive,
  creditBytes: positive,
  /** The connection is asked to reconnect after this long. */
  maxConnectionAgeMs: positive,
});
export type Welcome = z.infer<typeof welcomeSchema>;

/**
 * The server's ack for one session's events, sent after the commit. `upTo` is the highest session
 * number saved. `resendFrom` is set when a batch didn't start at `upTo + 1`: the peer resends from
 * there, so a gap can't be committed.
 */
export const ackSchema = z.strictObject({
  type: z.literal("ack"),
  sessionId: sessionIdSchema,
  upTo: count,
  resendFrom: sessionSeqSchema.optional(),
});
export type Ack = z.infer<typeof ackSchema>;

/** More window for the peer: it may send this many more frames and bytes. */
export const creditSchema = z.strictObject({ type: z.literal("credit"), frames: positive, bytes: positive });
export type Credit = z.infer<typeof creditSchema>;

/** The replica is going away or rebalancing: reconnect after the given time. */
export const goawaySchema = z.strictObject({
  type: z.literal("goaway"),
  reconnectAfterMs: count,
  reason: z.enum(["draining", "max-age", "rebalance"]),
});
export type Goaway = z.infer<typeof goawaySchema>;

export const protocolErrorCodeSchema = z.enum([
  /** The lease epoch is behind the task's, or the grace ended: the write is refused (Q111). */
  "stale-lease",
  /** The peer's version is outside the window; `supported` and `serverMinor` say what is. */
  "version-unsupported",
  /** A frame that doesn't parse, breaks the credit window or comes out of order. */
  "protocol-violation",
  /** The access token or the peer identity is refused. */
  "unauthorized",
  /** A newer connection of this peer took over. */
  "replaced",
  /** The session is not this peer's, or doesn't exist. */
  "unknown-session",
  /** A runner sent a kind only the server writes. */
  "forbidden-kind",
  "internal",
]);
export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>;

export const errorFrameSchema = z.strictObject({
  type: z.literal("error"),
  code: protocolErrorCodeSchema,
  /** For a person reading the runner's log. Never holds content. */
  message: z.string().max(2000),
  sessionId: sessionIdSchema.optional(),
  currentEpoch: leaseEpochSchema.optional(),
  supported: z.strictObject({ min: count, max: count }).optional(),
  serverMinor: count.optional(),
});
export type ErrorFrame = z.infer<typeof errorFrameSchema>;

/** The runner is revoked or replaced. The server closes with `4403` or `4409` after it. */
export const evictSchema = z.strictObject({
  type: z.literal("evict"),
  reason: z.enum(["revoked", "replaced"]),
});
export type Evict = z.infer<typeof evictSchema>;

const downFrameV0 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchema,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
export type DownFrame = z.infer<typeof downFrameV0>;
export type DownFrameType = DownFrame["type"];

// ---------- codecs and parsing ----------

/** Up frames, one codec per kept minor. */
export const upFrameCodec = createVersionedCodec<UpFrame>([
  { minor: 0, decode: upFrameV0, encode: (frame) => frame },
]);

/** Down frames, one codec per kept minor. */
export const downFrameCodec = createVersionedCodec<DownFrame>([
  { minor: 0, decode: downFrameV0, encode: (frame) => frame },
]);

/** Parse a frame a peer sent at `minor`. Never throws; the error names paths, never values. */
export const parseUpFrame = (text: string, minor: number = PROTOCOL_MINOR): FrameParse<UpFrame> =>
  upFrameCodec.parse(text, minor);

/** Parse a frame the server sent at `minor`. Never throws; the error names paths, never values. */
export const parseDownFrame = (text: string, minor: number = PROTOCOL_MINOR): FrameParse<DownFrame> =>
  downFrameCodec.parse(text, minor);

/** A frame as text for a server at `minor`. */
export const encodeUpFrame = (frame: UpFrame, minor: number = PROTOCOL_MINOR): string =>
  upFrameCodec.encode(frame, minor);

/** A frame as text for a peer at `minor`. */
export const encodeDownFrame = (frame: DownFrame, minor: number = PROTOCOL_MINOR): string =>
  downFrameCodec.encode(frame, minor);

// ---------- close codes ----------

/** WebSocket close codes (ADR 0034). 1000 and 1001 keep their standard meaning. */
export const closeCodes = {
  /** A frame broke the protocol. */
  protocolViolation: 4400,
  /** The access token expired: get a new one and reconnect. */
  tokenExpired: 4401,
  /** The runner is revoked: don't reconnect. */
  revoked: 4403,
  /** A newer connection of this peer took over: don't fight it. */
  replaced: 4409,
  /** The peer's version is outside the window: update, then retry. */
  upgradeRequired: 4426,
  /** No `hello` within the handshake timeout. */
  handshakeTimeout: 4408,
  /** The replica is draining: reconnect after a jittered wait. */
  draining: 4503,
} as const;
export type CloseCode = (typeof closeCodes)[keyof typeof closeCodes];
