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

/**
 * Milestone 8 (ADR 0068): what an init does beyond milestone 5's frames: the app's processes with
 * their own stop (`app`), the browser and its pipe (`browser`), and the forwarder (`forward`).
 * The pool runner names the ones its sidecar reads in the init's `OSTRA_BRIDGE_FEATURES`, and the
 * init's hello lists those it has too, so a sidecar never sends an older init (an older base image
 * or snapshot) a frame it would refuse, and an older sidecar never gets a hello field it would.
 */
export const bridgeFeatureSchema = z.enum(["app", "browser", "forward"]);
export type BridgeFeature = z.infer<typeof bridgeFeatureSchema>;
export const BRIDGE_FEATURES: readonly BridgeFeature[] = bridgeFeatureSchema.options;

/** A browser the sidecar asked the init to start. Per connection, from 1. */
export const browserIdSchema = z.number().int().positive().brand<"BrowserId">();
export type BrowserId = z.infer<typeof browserIdSchema>;
/** A forwarder the sidecar asked the init to open. Per connection, from 1. */
export const forwardIdSchema = z.number().int().positive().brand<"ForwardId">();
export type ForwardId = z.infer<typeof forwardIdSchema>;

/** Why an init has no browser to start: the image has none, or it didn't start (`NoBrowserReason`'s two the init can say). */
export const initNoBrowserReasonSchema = z.enum(["not-in-image", "failed-to-start"]);

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
    /** Milestone 8: the features both this init and its sidecar have; absent, none. */
    features: z.array(bridgeFeatureSchema).max(bridgeFeatureSchema.options.length).optional(),
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
  // ---- milestone 8: the browser (feature `browser`) and the forwarder (`forward`) ----
  /** The browser runs: its PID, its program's name (never its path's folders) and its fresh profile. */
  z.strictObject({
    t: z.literal("browser_started"),
    reqId: reqIdSchema,
    browserId: browserIdSchema,
    pid: z.number().int().positive(),
    program: z.string().min(1).max(200),
    profileDir: absolutePath,
  }),
  z.strictObject({ t: z.literal("browser_unavailable"), reqId: reqIdSchema, browserId: browserIdSchema, reason: initNoBrowserReasonSchema }),
  /** Bytes the browser wrote on its DevTools pipe (its fd 4): its own channel, never queued behind a control frame. */
  z.strictObject({ t: z.literal("browser_out"), browserId: browserIdSchema, data: base64 }),
  /** The browser has exited and its profile folder is gone. */
  z.strictObject({ t: z.literal("browser_gone"), browserId: browserIdSchema }),
  /** The forwarder listens: where the sidecar dials it, on the box network. */
  z.strictObject({ t: z.literal("forward_opened"), reqId: reqIdSchema, forwardId: forwardIdSchema, host: z.string().min(1).max(64), port: z.number().int().min(1).max(65_535) }),
]);
export type InitFrame = z.infer<typeof initFrameSchema>;

export const preparedFileSchema = z.strictObject({
  path: absolutePath,
  content: base64,
  /** Octal file mode, such as 0o600. */
  mode: z.number().int().min(0).max(0o777),
});

/**
 * The prepare step's job: the folders to make, then the files to write, as the agent's user. The
 * init hands it to its prepare child (`init/prepare.ts`), which checks it again before the first write.
 */
export const prepareJobSchema = z.strictObject({
  dirs: z.array(absolutePath).max(64),
  files: z.array(preparedFileSchema).max(64),
});
export type PrepareJob = z.infer<typeof prepareJobSchema>;

/** Frames from the sidecar to the init. */
export const sidecarFrameSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("welcome"), version: z.literal(BRIDGE_VERSION) }),
  /** Make folders and write files as the agent's user. */
  z.strictObject({
    t: z.literal("prepare"),
    reqId: reqIdSchema,
    ...prepareJobSchema.shape,
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
  // ---- milestone 8 (ADR 0068) ----
  /**
   * Feature `app`: one of the app's long-running processes, as `spawn` with no stdin, in a process
   * group of its own so `app_stop` ends its tree. Its output comes as `out` frames, which the
   * sidecar writes to its log on the task volume.
   */
  z.strictObject({
    t: z.literal("app_spawn"),
    reqId: reqIdSchema,
    procId: procIdSchema,
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(65_536)).max(256),
    cwd: absolutePath,
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_()]*$/), z.string().max(65_536)),
  }),
  /** Feature `app`: a polite signal to the process's group, then a kill of its tree after `graceMs`; `done` once it exited. */
  z.strictObject({ t: z.literal("app_stop"), reqId: reqIdSchema, procId: procIdSchema, graceMs: z.number().int().min(0).max(60_000) }),
  /** Feature `browser`: start the image's browser with a fresh profile and its DevTools pipe. */
  z.strictObject({ t: z.literal("browser_start"), reqId: reqIdSchema, browserId: browserIdSchema }),
  /** Bytes for the browser's DevTools pipe (its fd 3). Written at once, never queued behind a control frame. */
  z.strictObject({ t: z.literal("browser_in"), browserId: browserIdSchema, data: base64 }),
  /** Kill the browser's tree and remove its profile; `done` once both are done. */
  z.strictObject({ t: z.literal("browser_kill"), reqId: reqIdSchema, browserId: browserIdSchema }),
  /**
   * Feature `forward`: listen on the box network, at a port the init picks, for the sidecar's
   * address only, and dial `localhost:<port>` (IPv6 and IPv4) for each connection. A port below
   * 1024 is refused with `error`.
   */
  z.strictObject({ t: z.literal("forward_open"), reqId: reqIdSchema, forwardId: forwardIdSchema, port: z.number().int().min(1).max(65_535) }),
  z.strictObject({ t: z.literal("forward_close"), reqId: reqIdSchema, forwardId: forwardIdSchema }),
]);
export type SidecarFrame = z.infer<typeof sidecarFrameSchema>;

/** The longest frame either side accepts. A base64 chunk of 64 KiB is about 88 KiB of JSON. */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Stdio chunks are split to this size before encoding. */
export const CHUNK_BYTES = 64 * 1024;
/** Spike 3, recommendation 9: every bridge request gets a deadline, so a hung init can't hold a stop. */
export const REQUEST_DEADLINE_MS = 30_000;
