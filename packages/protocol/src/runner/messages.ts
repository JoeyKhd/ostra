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
import { encodeEventForMinor, runnerEventSchema, runnerEventSchemaV0 } from "../events/agent-events.ts";
import { liveTextFrameSchema } from "../events/live-text.ts";
import { commandResultSchema, commandSchema, commandSchemaV0 } from "./commands.ts";
import { runnerLimits } from "./limits.ts";
import { peerSchema } from "./peer.ts";
import { createVersionedCodec, PROTOCOL_MINOR } from "./version.ts";
import type { FrameParse } from "./version.ts";

// The runner protocol's frames (ADR 0034): one JSON envelope per WebSocket text frame,
// discriminated on `type`. ostra owns the format, so every frame is a strict object except
// `hello`, the negotiation, which tolerates unknown fields. Ported from
// spikes/runner-transport/src/protocol/messages.ts.
//
// Minor 1 (milestone 2) adds event kinds and fields, and the `release` command. Minor 0's codec
// stays beside it: its `decode` refuses what minor 1 added, and its `encode` drops the new fields.
// A new kind is never encoded down: the sender checks `eventKindSupportedAt` and
// `commandKindSupportedAt` before it makes one.

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

/** Minor 0's `events` frame: its events refuse minor 1's kinds and fields. */
const eventsFrameSchemaV0 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV0).min(1).max(runnerLimits.eventsPerFrameMax),
});

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

/**
 * How a runner ends every process of a task together (ADR 0029, Q126): a box's container, a
 * Windows job object, a Linux cgroup, or the agent's process tree, which can miss a process that
 * detached itself. The panel says so for `process-tree`.
 */
export const processContainmentSchema = z.enum(["container", "job-object", "cgroup", "process-tree"]);
export type ProcessContainment = z.infer<typeof processContainmentSchema>;

/** What the peer can take, sent after `welcome` and whenever it changes (F-013, F-067). */
const statusSchemaV0 = z.strictObject({
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

/**
 * Minor 1 (milestone 2's ticket 42): the status also says how the runner contains a task's
 * processes. Optional: a sidecar and an older runner leave it out. Minor 0 never sees it.
 */
export const statusSchema = statusSchemaV0.extend({
  processContainment: processContainmentSchema.optional(),
});
export type Status = z.infer<typeof statusSchema>;

/** Partial text: unsequenced, never spooled, never acked (ADR 0035). */
export const liveTextSchema = z.strictObject({
  type: z.literal("live-text"),
  frames: z.array(liveTextFrameSchema).min(1).max(runnerLimits.liveTextPerFrameMax),
});
export type LiveText = z.infer<typeof liveTextSchema>;

const upFrameV1 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchema,
  commandAckSchema,
  statusSchema,
  liveTextSchema,
]);
const upFrameV0 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV0,
  commandAckSchema,
  statusSchemaV0,
  liveTextSchema,
]);
export type UpFrame = z.infer<typeof upFrameV1>;
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
  /**
   * The database refused an event (SQLSTATE class 22 or 23) and not even a placeholder could be
   * stored in its place: the event is skipped, the session's cursor moves past it, and the `ack`
   * covers it. `sessionId` and `sessionSeq` name it. The runner drops it from its spool; it never
   * resends it.
   */
  "event-rejected",
  "internal",
]);
export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>;

export const errorFrameSchema = z.strictObject({
  type: z.literal("error"),
  code: protocolErrorCodeSchema,
  /** For a person reading the runner's log. Never holds content. */
  message: z.string().max(2000),
  sessionId: sessionIdSchema.optional(),
  /** With `event-rejected`: the number of the refused event in its session. */
  sessionSeq: sessionSeqSchema.optional(),
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

const downFrameV1 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchema,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV0 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchemaV0,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
export type DownFrame = z.infer<typeof downFrameV1>;
export type DownFrameType = DownFrame["type"];

// ---------- codecs and parsing ----------

/** A status in minor 0's shape: without `processContainment`. */
const statusForMinor0 = (frame: Status): unknown => {
  const minor0: Record<string, unknown> = { ...frame };
  Reflect.deleteProperty(minor0, "processContainment");
  return minor0;
};

/** An up frame in minor 0's shape: an `events` frame's events lose minor 1's fields, and a status its containment. */
const encodeUpFrameV0 = (frame: UpFrame): unknown =>
  frame.type === "events"
    ? { ...frame, events: frame.events.map((item) => ({ ...item, event: encodeEventForMinor(item.event, 0) })) }
    : frame.type === "status"
      ? statusForMinor0(frame)
      : frame;

/** Up frames, one codec per kept minor. */
export const upFrameCodec = createVersionedCodec<UpFrame>([
  { minor: 0, decode: upFrameV0, encode: encodeUpFrameV0 },
  { minor: 1, decode: upFrameV1, encode: (frame) => frame },
]);

/**
 * Down frames, one codec per kept minor. No down frame changed shape in minor 1; only the
 * `release` command is new, and minor 0's decode refuses it.
 */
export const downFrameCodec = createVersionedCodec<DownFrame>([
  { minor: 0, decode: downFrameV0, encode: (frame) => frame },
  { minor: 1, decode: downFrameV1, encode: (frame) => frame },
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
