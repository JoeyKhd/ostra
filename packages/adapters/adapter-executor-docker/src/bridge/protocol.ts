import { boxIdSchema } from "@ostra/protocol";
import { z } from "zod";

// The bridge between a box's sidecar and its agent's container (ADR 0029: the sidecar holds the
// ACP driver; the agent runs in its own container). Ported from
// spikes/what-is-inside-a-box/src/bridge/protocol.ts.
//
// The box's init program, in the agent's container, connects out to the sidecar's bridge port once,
// at box start, before any agent code runs. The sidecar accepts the first connection that presents
// the box's nonce and then closes the port, so nothing the agent starts later can take the bridge
// over. Over that one connection the sidecar asks the init to make the task's folders, spawn
// processes as the agent's user, carry their stdio, list them and kill them. The init holds no
// credential: the frames carry only what the agent may hold (the fake key, ADR 0030).
//
// One JSON object per line. ostra owns this format, so every schema is strict.

/** A box's name on the bridge: the box ID, as its containers are named. */
export const bridgeBoxIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "a box ID")
  .pipe(boxIdSchema);

/** A process the sidecar asked the init to start. Per connection, from 1. */
export const procIdSchema = z.number().int().positive().brand<"ProcId">();
export type ProcId = z.infer<typeof procIdSchema>;
/** A request over the bridge, answered by the frame with the same ID. Per connection, from 1. */
export const reqIdSchema = z.number().int().positive().brand<"ReqId">();
export type ReqId = z.infer<typeof reqIdSchema>;

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
/** Absolute: POSIX in a box; a drive path only when a test runs the init on Windows. */
const absolutePath = z
  .string()
  .regex(/^(\/|[A-Za-z]:[\\/])[^\0]*$/)
  .max(4096);

export const bridgeProcessSchema = z.strictObject({
  pid: z.number().int(),
  ppid: z.number().int(),
  name: z.string(),
  startedAt: z.number().nonnegative(),
});
export type BridgeProcess = z.infer<typeof bridgeProcessSchema>;

export const BRIDGE_VERSION = 1;

/** Frames from the init (the agent's container) to the sidecar. */
export const initFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("hello"),
    version: z.literal(BRIDGE_VERSION),
    boxId: bridgeBoxIdSchema,
    /** The box's one-time bridge nonce, from the init's own environment (which the agent's user can't read). */
    nonce: z.string().min(32).max(128),
    initPid: z.number().int(),
    agentUid: z.number().int().nonnegative(),
    platform: z.enum(["linux", "darwin", "win32"]),
  }),
  z.strictObject({ t: z.literal("prepared"), reqId: reqIdSchema, error: z.string().max(2000).optional() }),
  z.strictObject({ t: z.literal("spawned"), reqId: reqIdSchema, procId: procIdSchema, pid: z.number().int().positive() }),
  z.strictObject({ t: z.literal("spawn_failed"), reqId: reqIdSchema, procId: procIdSchema, message: z.string().max(2000) }),
  z.strictObject({ t: z.literal("out"), procId: procIdSchema, stream: z.enum(["stdout", "stderr"]), data: base64 }),
  z.strictObject({ t: z.literal("eof"), procId: procIdSchema, stream: z.enum(["stdout", "stderr"]) }),
  z.strictObject({ t: z.literal("exit"), procId: procIdSchema, code: z.number().int().nullable(), signal: z.string().max(64).nullable() }),
  z.strictObject({ t: z.literal("ps_result"), reqId: reqIdSchema, processes: z.array(bridgeProcessSchema).max(10_000) }),
  z.strictObject({ t: z.literal("done"), reqId: reqIdSchema }),
  z.strictObject({ t: z.literal("error"), reqId: reqIdSchema, message: z.string().max(2000) }),
]);
export type InitFrame = z.infer<typeof initFrameSchema>;

export const preparedFileSchema = z.strictObject({
  path: absolutePath,
  content: base64,
  /** Octal file mode, such as 0o600. */
  mode: z.number().int().min(0).max(0o777),
});

/** Frames from the sidecar to the init. */
export const sidecarFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("welcome"), version: z.literal(BRIDGE_VERSION) }),
  /** Make folders and write files as the agent's user. */
  z.strictObject({
    t: z.literal("prepare"),
    reqId: reqIdSchema,
    dirs: z.array(absolutePath).max(64),
    files: z.array(preparedFileSchema).max(64),
  }),
  z.strictObject({
    t: z.literal("spawn"),
    reqId: reqIdSchema,
    procId: procIdSchema,
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(65_536)).max(256),
    cwd: absolutePath,
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/), z.string().max(65_536)),
  }),
  z.strictObject({ t: z.literal("in"), procId: procIdSchema, data: base64 }),
  z.strictObject({ t: z.literal("in_end"), procId: procIdSchema }),
  z.strictObject({ t: z.literal("ps"), reqId: reqIdSchema }),
  z.strictObject({ t: z.literal("kill_tree"), reqId: reqIdSchema, pid: z.number().int().positive() }),
  /** Kill every process of the agent's user, then report what's left. "Stop the task". */
  z.strictObject({ t: z.literal("reap_all"), reqId: reqIdSchema }),
]);
export type SidecarFrame = z.infer<typeof sidecarFrameSchema>;

/** The longest frame either side accepts. A base64 chunk of 64 KiB is about 88 KiB of JSON. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Stdio chunks are split to this size before encoding. */
export const CHUNK_BYTES = 64 * 1024;
/** Spike 3, recommendation 9: every bridge request gets a deadline, so a hung init can't hold a stop. */
export const REQUEST_DEADLINE_MS = 30_000;
