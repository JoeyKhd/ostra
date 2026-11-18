// The bridge between the sidecar and the agent's container (ADR 0029: the
// sidecar holds the ACP driver; the agent runs in its own container).
//
// The box's init program, in the agent's container, connects out to the
// sidecar's bridge port once, at box start, before any agent code runs. The
// sidecar accepts the first connection that presents the box's nonce and then
// closes the port, so nothing the agent starts later can take the bridge over.
//
// Over that one connection, the sidecar asks the init to prepare the task's
// directories, spawn `opencode acp` as the agent's user, carry its stdio, list
// its processes and kill them. The init holds no credential: the frames carry
// only the fake key, which the agent is allowed to hold (ADR 0030).
//
// One JSON object per line. ostra owns this format, so every schema is strict.

import { z } from "zod";

export const BoxIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,40}$/).brand<"BoxId">();
export type BoxId = z.infer<typeof BoxIdSchema>;
export const boxId = (value: string): BoxId => BoxIdSchema.parse(value);

/** A process the sidecar asked the init to start. Per connection, from 1. */
export const ProcIdSchema = z.number().int().positive().brand<"ProcId">();
export type ProcId = z.infer<typeof ProcIdSchema>;
export const toProcId = (value: number): ProcId => ProcIdSchema.parse(value);
/** A request over the bridge, answered by the frame with the same id. Per connection, from 1. */
export const ReqIdSchema = z.number().int().positive().brand<"ReqId">();
export type ReqId = z.infer<typeof ReqIdSchema>;
export const toReqId = (value: number): ReqId => ReqIdSchema.parse(value);
const procId = ProcIdSchema;
const reqId = ReqIdSchema;
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** Absolute: POSIX in a box; a drive path only in the loopback rehearsal on Windows. */
const absolutePath = z
  .string()
  .regex(/^(\/|[A-Za-z]:[\\/])[^\0]*$/)
  .max(4096);

export const processInfoSchema = z.strictObject({
  pid: z.number().int(),
  ppid: z.number().int(),
  name: z.string(),
  commandLine: z.string(),
  rssBytes: z.number().nonnegative(),
  startedAt: z.number().nonnegative(),
});

export const BRIDGE_VERSION = 1;

/** Frames from the init (agent's container) to the sidecar. */
export const initFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("hello"),
    version: z.literal(BRIDGE_VERSION),
    boxId: BoxIdSchema,
    /** The box's one-time bridge nonce, from the init's own environment (unreadable by the agent's user). */
    nonce: z.string().min(32).max(128),
    initPid: z.number().int(),
    agentUid: z.number().int().nonnegative(),
    platform: z.enum(["linux", "darwin", "win32"]),
  }),
  z.strictObject({ t: z.literal("prepared"), reqId, error: z.string().optional() }),
  z.strictObject({ t: z.literal("spawned"), reqId, procId, pid: z.number().int().positive() }),
  z.strictObject({ t: z.literal("spawn_failed"), reqId, procId, message: z.string() }),
  z.strictObject({ t: z.literal("out"), procId, stream: z.enum(["stdout", "stderr"]), data: base64 }),
  z.strictObject({ t: z.literal("eof"), procId, stream: z.enum(["stdout", "stderr"]) }),
  z.strictObject({ t: z.literal("exit"), procId, code: z.number().int().nullable(), signal: z.string().nullable() }),
  z.strictObject({ t: z.literal("ps_result"), reqId, processes: z.array(processInfoSchema) }),
  z.strictObject({ t: z.literal("done"), reqId }),
  z.strictObject({ t: z.literal("error"), reqId, message: z.string() }),
]);
export type InitFrame = z.infer<typeof initFrameSchema>;

export const preparedFileSchema = z.strictObject({
  path: absolutePath,
  content: base64,
  /** Octal file mode, e.g. 0o600. */
  mode: z.number().int().min(0).max(0o777),
});

/** Frames from the sidecar to the init. */
export const sidecarFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("welcome"), version: z.literal(BRIDGE_VERSION) }),
  /** Create directories and write files as the agent's user (the task's dirs and OpenCode's config). */
  z.strictObject({
    t: z.literal("prepare"),
    reqId,
    dirs: z.array(absolutePath).max(64),
    files: z.array(preparedFileSchema).max(64),
  }),
  z.strictObject({
    t: z.literal("spawn"),
    reqId,
    procId,
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(65_536)).max(256),
    cwd: absolutePath,
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65_536)),
  }),
  z.strictObject({ t: z.literal("in"), procId, data: base64 }),
  z.strictObject({ t: z.literal("in_end"), procId }),
  z.strictObject({ t: z.literal("ps"), reqId }),
  z.strictObject({ t: z.literal("kill_tree"), reqId, pid: z.number().int().positive() }),
  z.strictObject({ t: z.literal("kill_one"), reqId, pid: z.number().int().positive() }),
  /** Kill every process of the agent's user, then report. Used by "stop the task". */
  z.strictObject({ t: z.literal("reap_all"), reqId }),
]);
export type SidecarFrame = z.infer<typeof sidecarFrameSchema>;

/** Longest frame either side accepts. A base64 chunk of 64 KiB is ~88 KiB of JSON. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Stdio chunks are split to this size before encoding. */
export const CHUNK_BYTES = 64 * 1024;
