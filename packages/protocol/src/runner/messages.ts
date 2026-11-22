import { z } from "zod";

import { commandIdSchema, poolIdSchema, replicaIdSchema, sessionIdSchema, taskIdSchema } from "../ids.ts";
import {
  commandSeqSchema,
  epochMsSchema,
  executorKindSchema,
  leaseEpochSchema,
  legacyRunnerLabelPattern,
  runnerLabelSchema,
  sessionSeqSchema,
} from "../common.ts";
import type { ExecutorKind } from "../common.ts";
import {
  encodeEventForMinor,
  eventKindMinMinor,
  runnerEventSchema,
  runnerEventSchemaV0,
  runnerEventSchemaV1,
  runnerEventSchemaV2,
  runnerEventSchemaV3,
  runnerEventSchemaV4,
  runnerEventSchemaV5,
  runnerEventSchemaV6,
  runnerEventSchemaV7,
  runnerScopedEventKinds,
  taskEventSchema,
} from "../events/agent-events.ts";
import { liveTextFrameSchema } from "../events/live-text.ts";
import {
  commandResultSchema,
  commandSchema,
  commandSchemaV0,
  commandSchemaV1,
  commandSchemaV2,
  commandSchemaV3,
  commandSchemaV4,
  commandSchemaV5,
  commandSchemaV7,
  commandSchemaV7WebSocket,
  commandSchemaV8WebSocket,
  encodeCommandForMinor,
} from "./commands.ts";
import { boxBrowserSchema } from "../task/app.ts";
import { previewSupportSchema } from "./preview.ts";
import { runnerLimits } from "./limits.ts";
import { peerSchema } from "./peer.ts";
import { createVersionedCodec, PROTOCOL_MINOR } from "./version.ts";
import type { FrameParse } from "./version.ts";

// The runner protocol's frames (ADR 0034): one JSON envelope per WebSocket text frame,
// discriminated on `type`. ostra owns the format, so every frame is a strict object except
// `hello`, the negotiation, which tolerates unknown fields. Ported from
// spikes/runner-transport/src/protocol/messages.ts.
//
// Minor 9 (milestone 10, F-151) adds no frame and no field to one: its frames are minor 8's. Its
// additions are a review answer's `already` over HTTP (`http.ts`) and three server events' optional
// fields, which no runner sends or reads.
//
// Minor 8 (milestone 9, ADR 0070) adds files for the agent: `files.written`, a `user.message`'s
// files, `ticket.context_read`, `ticket-update`, and a steer's files and images. Minor 7's codec
// refuses them, and its encode drops the fields; it refuses to encode a steer that carries files.
// It also adds a pool runner's `box.lost` runner event (F-047), which minor 7's codec refuses.
//
// Minor 7 (milestone 8, ADR 0068) adds the app's and the previews' events and commands, the
// dispatch's purpose, and what a runner can preview in `hello` and `status`: minor 6's codec
// refuses them, and its encode drops the fields. `preview.input` is the HTTP carrier's only: the
// WebSocket's down codec refuses it, and `httpDownFrameCodec` reads it.
//
// Minor 6 (milestone 7, F-138) adds the subagent events and the subagent on the agent's output:
// minor 5's codec refuses them, and its encode drops the field.
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

// ---------- what a runner reports (minor 4, milestone 5) ----------

/**
 * What a runner offers (F-067, F-095, ADR 0059): its slots, and on `docker` and `kubernetes` the
 * CPU and memory its boxes may take, as its whole offer (the engine's or the namespace quota's,
 * less the runner's reserve). Core subtracts the boxes it placed, counted from its own rows.
 * `null` on `host`, which counts `capacity` as slots.
 */
export const runnerResourcesSchema = z.strictObject({
  slots: count,
  cpuMillis: count,
  memoryMiB: count,
});
export type RunnerResources = z.infer<typeof runnerResourcesSchema>;

/** Whether an executor needs a registry for its snapshots (F-120): `kubernetes` does, `docker` may use one. */
export const registryNeedSchema = z.enum(["required", "optional", "none"]);
export type RegistryNeed = z.infer<typeof registryNeedSchema>;

/**
 * What a runner's executor can do (ADR 0025, ADR 0029), as `ExecutorAdapter` declares it: the
 * four milestones 1 to 3 built, and the registry and the node wait of minor 4.
 */
export const runnerCapabilitiesSchema = z.strictObject({
  /** `container`: the agent runs in a box with no credential. `none`: a worktree, "not isolated". */
  isolation: z.enum(["container", "none"]),
  services: z.boolean(),
  boxSizes: z.boolean(),
  snapshots: z.enum(["image", "host-cache", "none"]),
  registry: registryNeedSchema,
  /** A box may wait for a node while the cluster grows (`kubernetes`, F-093). */
  nodeWait: z.boolean(),
});
export type RunnerCapabilities = z.infer<typeof runnerCapabilitiesSchema>;

/** How a runner was installed, for the pin and the panel (ADR 0034, ADR 0046). */
export const runnerInstallSchema = z.enum(["npm", "image", "source"]);
export type RunnerInstall = z.infer<typeof runnerInstallSchema>;

/** Minor 4's fields of `hello` and `status`, all optional: a minor-3 peer sends none of them. */
const runnerReportFieldsV6 = {
  resources: runnerResourcesSchema.nullable().optional(),
  capabilities: runnerCapabilitiesSchema.optional(),
  install: runnerInstallSchema.optional(),
};

/**
 * Minor 7's fields of `hello` and `status` (ADR 0068), optional: what the runner can do for a
 * preview (the browser view, and the tunnel, never on the HTTP carrier), and a `host` runner's
 * browser (`null`: none found, and no download). A minor-6 peer sends neither and is sent neither.
 */
const runnerReportFieldsV7 = {
  preview: previewSupportSchema.optional(),
  browser: boxBrowserSchema.nullable().optional(),
};

const runnerReportFields = { ...runnerReportFieldsV6, ...runnerReportFieldsV7 };

/**
 * The first frame a peer sends. Its versions are negotiated (`negotiate`, then
 * `refuseHelloExecutor`), and its peer identity must match the access token it connected with.
 * The one loose message: a newer peer may add fields an older server ignores. Minor 4 adds the
 * runner's executor and what it reports; a peer below minor 4 is never sent them, and never sends them.
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
  /** Minor 4: the runner's executor, so a `kubernetes` runner below minor 4 is refused at once. */
  executor: executorKindSchema.optional(),
  ...runnerReportFields,
});
export type Hello = z.infer<typeof helloSchema>;

/** The lowest minor an executor's runner may speak: `kubernetes` is new in minor 4 (ADR 0034). */
export const executorMinMinor = (executor: ExecutorKind): number => {
  switch (executor) {
    case "kubernetes":
      return 4;
    case "docker":
    case "host":
      return 0;
    default:
      return executor satisfies never;
  }
};

/** Why a `hello` inside the window is still refused: its executor needs a later minor. */
export type HelloExecutorRefusal = {
  readonly reason: "executor-needs-minor";
  readonly executor: ExecutorKind;
  readonly minMinor: number;
};

/**
 * Checks a `hello` against the minor negotiated for it (ADR 0034): a `kubernetes` runner below
 * minor 4 is refused with its own reason. The executor is the one `hello` names, or else the one
 * the runner registered with (a minor-3 runner's `hello` names none). `null` when the executor may
 * speak `minor`. Run after `negotiate`, which settles the window.
 */
export const refuseHelloExecutor = (
  hello: Hello,
  minor: number,
  registeredExecutor?: ExecutorKind,
): HelloExecutorRefusal | null => {
  const executor = hello.executor ?? registeredExecutor;
  if (executor === undefined) {
    return null;
  }
  const minMinor = executorMinMinor(executor);
  return Math.min(minor, hello.protocolMinor) < minMinor ? { reason: "executor-needs-minor", executor, minMinor } : null;
};

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

/** Minor 7's `events` frame: its events refuse minor 8's kinds and fields. */
const eventsFrameSchemaV7 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV7).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 6's `events` frame: its events refuse minor 7's kinds. */
const eventsFrameSchemaV6 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV6).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 5's `events` frame: its events refuse minor 6's kinds and the subagent on the agent's output. */
const eventsFrameSchemaV5 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV5).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 4's `events` frame: its events refuse minor 5's kinds and intents. */
const eventsFrameSchemaV4 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV4).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 3's `events` frame: its events refuse minor 4's kinds. */
const eventsFrameSchemaV3 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV3).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 2's `events` frame: its events refuse minor 3's kinds. */
const eventsFrameSchemaV2 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV2).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 1's `events` frame: its events refuse minor 2's kinds and fields. */
const eventsFrameSchemaV1 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV1).min(1).max(runnerLimits.eventsPerFrameMax),
});

/** Minor 0's `events` frame: its events refuse minor 1's kinds and fields. */
const eventsFrameSchemaV0 = eventsFrameSchema.extend({
  events: z.array(runnerEventSchemaV0).min(1).max(runnerLimits.eventsPerFrameMax),
});

/**
 * A runner's own event, outside any task (minor 2): a snapshot build's result when no task
 * triggered it (F-051). Core applies it idempotently by `snapshotId`. The runner acks the
 * `snapshot-build` command `done` only after it sent this frame, so a connection lost in between
 * resends the command and the runner reports the result again. Minor 4 adds a box's wait, and
 * minor 8 a lost box (`box.lost`, F-047), which core applies by the box's ID.
 */
export const runnerEventFrameSchema = z.strictObject({
  type: z.literal("runner-event"),
  /** When the runner recorded it, in ms since the epoch, by its clock. */
  at: epochMsSchema,
  event: taskEventSchema.refine((event) => runnerScopedEventKinds.has(event.kind), {
    message: "only a snapshot's result, a box's wait or a lost box is a runner event",
  }),
});
export type RunnerEventFrame = z.infer<typeof runnerEventFrameSchema>;

/** `runner-event` from minor 4 to minor 7: a snapshot's result or a box's wait; a lost box is new in minor 8. */
const runnerEventFrameSchemaV7 = runnerEventFrameSchema.refine((frame) => eventKindMinMinor(frame.event.kind) < 8, {
  message: "a lost box is a runner event from minor 8",
});

/** `runner-event` below minor 4: a snapshot's result only; a box's wait is new in minor 4. */
const runnerEventFrameSchemaV3 = runnerEventFrameSchema.refine((frame) => eventKindMinMinor(frame.event.kind) < 4, {
  message: "a box's wait is a runner event from minor 4",
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
const statusSchemaV3 = statusSchemaV0.extend({
  processContainment: processContainmentSchema.optional(),
});

/**
 * The status at minors 4 to 6: minor 1's, with what the runner offers (`resources`), what its
 * executor can do (`capabilities`) and how it was installed (`install`). A minor-3 server is sent
 * none of them, and only the labels it can read.
 */
const statusSchemaV6 = statusSchemaV3.extend(runnerReportFieldsV6);

/**
 * The status at the current minor (9), which minor 7 shaped: minor 4's, with what the runner can
 * preview and a `host` runner's browser.
 */
export const statusSchema = statusSchemaV6.extend(runnerReportFieldsV7);
export type Status = z.infer<typeof statusSchema>;

/** Partial text: unsequenced, never spooled, never acked (ADR 0035). */
export const liveTextSchema = z.strictObject({
  type: z.literal("live-text"),
  frames: z.array(liveTextFrameSchema).min(1).max(runnerLimits.liveTextPerFrameMax),
});
export type LiveText = z.infer<typeof liveTextSchema>;

const upFrameV8 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchema,
  commandAckSchema,
  statusSchema,
  liveTextSchema,
  runnerEventFrameSchema,
]);
const upFrameV7 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV7,
  commandAckSchema,
  statusSchema,
  liveTextSchema,
  runnerEventFrameSchemaV7,
]);
const upFrameV6 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV6,
  commandAckSchema,
  statusSchemaV6,
  liveTextSchema,
  runnerEventFrameSchemaV7,
]);
const upFrameV5 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV5,
  commandAckSchema,
  statusSchemaV6,
  liveTextSchema,
  runnerEventFrameSchemaV7,
]);
const upFrameV4 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV4,
  commandAckSchema,
  statusSchemaV6,
  liveTextSchema,
  runnerEventFrameSchemaV7,
]);
const upFrameV3 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV3,
  commandAckSchema,
  statusSchemaV3,
  liveTextSchema,
  runnerEventFrameSchemaV3,
]);
const upFrameV2 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV2,
  commandAckSchema,
  statusSchemaV3,
  liveTextSchema,
  runnerEventFrameSchemaV3,
]);
const upFrameV1 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV1,
  commandAckSchema,
  statusSchemaV3,
  liveTextSchema,
]);
const upFrameV0 = z.discriminatedUnion("type", [
  helloSchema,
  eventsFrameSchemaV0,
  commandAckSchema,
  statusSchemaV0,
  liveTextSchema,
]);
export type UpFrame = z.infer<typeof upFrameV8>;
export type UpFrameType = UpFrame["type"];

// ---------- down: server to peer ----------

/** The server's answer to `hello`: the negotiated minor, its clock and the credit window. */
/** `welcome` up to minor 3. */
const welcomeSchemaV3 = z.strictObject({
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

/**
 * Minor 4 (F-091, Q130): a pool runner's pool, and whether it waits for an admin's approval
 * before it's offered anything. Core sends it to a pool runner only; when an admin approves a
 * connected runner, core sends it `resume`, which lifts that hold as it lifts a drain.
 */
export const welcomePoolSchema = z.strictObject({
  poolId: poolIdSchema,
  /** The pool's name, as the panel shows it. */
  name: z.string().min(1).max(200),
  awaitingApproval: z.boolean(),
});
export type WelcomePool = z.infer<typeof welcomePoolSchema>;

/** `welcome` at the current minor (4): minor 3's, with a pool runner's `pool`. A minor-3 peer is never sent it. */
export const welcomeSchema = welcomeSchemaV3.extend({ pool: welcomePoolSchema.optional() });
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

/** Minor 8's down frames on the HTTP carrier: every command, `preview.input` included. */
const downFrameV8Http = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchema,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
/** Minor 8's down frames on the WebSocket: no `preview.input`, which rides the preview connection there. */
const downFrameV8 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchemaV8WebSocket,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
/** Minor 7's down frames on the HTTP carrier: every command, `preview.input` included; a steer without files. */
const downFrameV7Http = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchemaV7,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
/** Minor 7's down frames on the WebSocket: no `preview.input`, which rides the preview connection there. */
const downFrameV7 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchemaV7WebSocket,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV5 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchemaV5,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV4 = z.discriminatedUnion("type", [
  welcomeSchema,
  ackSchema,
  creditSchema,
  commandSchemaV4,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV3 = z.discriminatedUnion("type", [
  welcomeSchemaV3,
  ackSchema,
  creditSchema,
  commandSchemaV3,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV2 = z.discriminatedUnion("type", [
  welcomeSchemaV3,
  ackSchema,
  creditSchema,
  commandSchemaV2,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV1 = z.discriminatedUnion("type", [
  welcomeSchemaV3,
  ackSchema,
  creditSchema,
  commandSchemaV1,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
const downFrameV0 = z.discriminatedUnion("type", [
  welcomeSchemaV3,
  ackSchema,
  creditSchema,
  commandSchemaV0,
  goawaySchema,
  errorFrameSchema,
  evictSchema,
]);
export type DownFrame = z.infer<typeof downFrameV8Http>;
export type DownFrameType = DownFrame["type"];

// ---------- codecs and parsing ----------

/** The fields minor 4 added to `hello` and `status`. */
const minor4ReportKeys = ["resources", "capabilities", "install"] as const;

/** The fields minor 7 added to `hello` and `status`. */
const minor7ReportKeys = ["preview", "browser"] as const;

/** A `hello` or a status in minor 6's shape: without what the runner can preview or its browser. */
const reportForMinor6 = <Frame extends Hello | Status>(frame: Frame): Frame => {
  if (!minor7ReportKeys.some((key) => key in frame)) {
    return frame;
  }
  const minor6 = { ...frame };
  for (const key of minor7ReportKeys) {
    Reflect.deleteProperty(minor6, key);
  }
  return minor6;
};

/**
 * A `hello` or a status in minor 3's shape: without what minor 4 added, and with only the labels
 * a minor-3 server reads (no `:` or `/`). A `hello` keeps its `executor`: it's the loose message,
 * so a minor-3 server ignores it.
 */
const reportForMinor3 = (frame: Hello | Status): Record<string, unknown> => {
  const minor3: Record<string, unknown> = { ...frame };
  for (const key of [...minor4ReportKeys, ...minor7ReportKeys]) {
    Reflect.deleteProperty(minor3, key);
  }
  if (frame.type === "status") {
    minor3["labels"] = frame.labels.filter((label) => legacyRunnerLabelPattern.test(label));
  }
  return minor3;
};

/**
 * An up frame in the shape of a lower minor: an `events` frame's events lose the newer fields,
 * below minor 4 a `hello` and a status lose what the runner reports, and below minor 1 a status
 * loses its containment.
 */
const encodeUpFrameFor =
  (minor: number) =>
  (frame: UpFrame): unknown => {
    if (frame.type === "events") {
      return { ...frame, events: frame.events.map((item) => ({ ...item, event: encodeEventForMinor(item.event, minor) })) };
    }
    if ((frame.type === "hello" || frame.type === "status") && minor >= 4 && minor < 7) {
      return reportForMinor6(frame);
    }
    if (frame.type === "hello" && minor < 4) {
      return reportForMinor3(frame);
    }
    if (frame.type === "status" && minor < 4) {
      const minor3 = reportForMinor3(frame);
      if (minor < 1) {
        Reflect.deleteProperty(minor3, "processContainment");
      }
      return minor3;
    }
    return frame;
  };

/** A down frame in the shape of a lower minor: a command loses the newer fields, `welcome` its pool. */
const encodeDownFrameFor =
  (minor: number) =>
  (frame: DownFrame): unknown => {
    if (frame.type === "command") {
      return encodeCommandForMinor(frame, minor);
    }
    if (frame.type === "welcome" && minor < 4) {
      const minor3: Record<string, unknown> = { ...frame };
      Reflect.deleteProperty(minor3, "pool");
      return minor3;
    }
    return frame;
  };

/** Up frames, one codec per kept minor. Minor 9 (milestone 10) adds no frame: its frames are minor 8's. */
export const upFrameCodec = createVersionedCodec<UpFrame>([
  { minor: 0, decode: upFrameV0, encode: encodeUpFrameFor(0) },
  { minor: 1, decode: upFrameV1, encode: encodeUpFrameFor(1) },
  { minor: 2, decode: upFrameV2, encode: encodeUpFrameFor(2) },
  { minor: 3, decode: upFrameV3, encode: encodeUpFrameFor(3) },
  { minor: 4, decode: upFrameV4, encode: encodeUpFrameFor(4) },
  { minor: 5, decode: upFrameV5, encode: encodeUpFrameFor(5) },
  { minor: 6, decode: upFrameV6, encode: encodeUpFrameFor(6) },
  { minor: 7, decode: upFrameV7, encode: encodeUpFrameFor(7) },
  { minor: 8, decode: upFrameV8, encode: (frame) => frame },
  { minor: 9, decode: upFrameV8, encode: (frame) => frame },
]);

/**
 * Down frames, one codec per kept minor. Minor 1 added the `release` command; minor 2 added three
 * commands and two command fields, which a lower minor's encode drops and its decode refuses.
 * Minor 3 added `set-effort` (F-137), which minor 2's decode refuses and the outbox never sends
 * it (`commandKindSupportedAt`). Minor 4 added `resume`, the dispatch's `box` and the snapshot
 * build's `push` and `builder`. Minor 5 added the dispatch's and the steer's `automatic` and
 * the steer's four new intents, which minor 4's encode drops and its decode refuses. Minor 6
 * (F-138) adds events only: its down frames are minor 5's. Minor 7 adds the dispatch's purpose,
 * which minor 6's encode drops, and the app's and the views' commands, which its decode refuses.
 * Minor 8 adds the steer's files and `ticket-update`, which minor 7's encode drops (and refuses
 * for a steer that carries files) and its decode refuses. Minor 9 (milestone 10) adds no frame:
 * its down frames are minor 8's. This is the WebSocket's codec: it refuses `preview.input`, the
 * HTTP carrier's only command.
 */
export const downFrameCodec = createVersionedCodec<DownFrame>([
  { minor: 0, decode: downFrameV0, encode: encodeDownFrameFor(0) },
  { minor: 1, decode: downFrameV1, encode: encodeDownFrameFor(1) },
  { minor: 2, decode: downFrameV2, encode: encodeDownFrameFor(2) },
  { minor: 3, decode: downFrameV3, encode: encodeDownFrameFor(3) },
  { minor: 4, decode: downFrameV4, encode: encodeDownFrameFor(4) },
  { minor: 5, decode: downFrameV5, encode: encodeDownFrameFor(5) },
  { minor: 6, decode: downFrameV5, encode: encodeDownFrameFor(6) },
  { minor: 7, decode: downFrameV7, encode: encodeDownFrameFor(7) },
  { minor: 8, decode: downFrameV8, encode: (frame) => frame },
  { minor: 9, decode: downFrameV8, encode: (frame) => frame },
]);

/**
 * The HTTP carrier's down frames (`GET /runner/v1/down`, Q306): the WebSocket's, and from minor 7
 * `preview.input` too, which brings a view's input down the long poll.
 */
export const httpDownFrameCodec = createVersionedCodec<DownFrame>([
  { minor: 0, decode: downFrameV0, encode: encodeDownFrameFor(0) },
  { minor: 1, decode: downFrameV1, encode: encodeDownFrameFor(1) },
  { minor: 2, decode: downFrameV2, encode: encodeDownFrameFor(2) },
  { minor: 3, decode: downFrameV3, encode: encodeDownFrameFor(3) },
  { minor: 4, decode: downFrameV4, encode: encodeDownFrameFor(4) },
  { minor: 5, decode: downFrameV5, encode: encodeDownFrameFor(5) },
  { minor: 6, decode: downFrameV5, encode: encodeDownFrameFor(6) },
  { minor: 7, decode: downFrameV7Http, encode: encodeDownFrameFor(7) },
  { minor: 8, decode: downFrameV8Http, encode: (frame) => frame },
  { minor: 9, decode: downFrameV8Http, encode: (frame) => frame },
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
