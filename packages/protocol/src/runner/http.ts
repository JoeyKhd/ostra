import { z } from "zod";

import { poolIdSchema, runnerIdSchema, taskIdSchema } from "../ids.ts";
import {
  epochMsSchema,
  executorKindSchema,
  httpUrlSchema,
  leaseEpochSchema,
  runnerKindSchema,
  runnerLabelSchema,
} from "../common.ts";
import { taskCredentialsSchema } from "../task/credentials.ts";
import { taskSpecSchema } from "../task/spec.ts";
import { downFrameCodec, protocolErrorCodeSchema, upFrameCodec } from "./messages.ts";
import type { DownFrame, UpFrame } from "./messages.ts";
import { RUNNER_PATH_PREFIX } from "./version.ts";

// The runner's HTTP endpoints beside the WebSocket (ADR 0034): request and response schemas only.
// The code is the runner's (tickets 15, 16) and the gateway's (ticket 24).

/** Every runner endpoint's path. */
export const runnerPaths = {
  info: `${RUNNER_PATH_PREFIX}/info`,
  register: `${RUNNER_PATH_PREFIX}/register`,
  token: `${RUNNER_PATH_PREFIX}/token`,
  connect: `${RUNNER_PATH_PREFIX}/connect`,
  taskSpec: (taskId: string): string => `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/spec`,
  taskCredentials: (taskId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/credentials`,
  // The HTTP fallback carrier (milestone 5).
  httpHello: `${RUNNER_PATH_PREFIX}/hello`,
  httpUp: `${RUNNER_PATH_PREFIX}/up`,
  httpDown: `${RUNNER_PATH_PREFIX}/down`,
} as const;

/** Headers the HTTP carrier uses (ADR 0034). */
export const runnerHeaders = {
  /** The negotiated minor, on every HTTP carrier request. */
  minor: "x-ostra-minor",
  /** The connection epoch from `welcome`; a newer connection answers `409`. */
  connectionEpoch: "x-ostra-connection-epoch",
} as const;

/** Any runner endpoint's error body. */
export const runnerHttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([...protocolErrorCodeSchema.options, "not-found", "bad-request", "conflict"]),
    message: z.string().max(2000),
    currentEpoch: leaseEpochSchema.optional(),
  }),
});
export type RunnerHttpError = z.infer<typeof runnerHttpErrorSchema>;

// ---------- GET /runner/v1/info ----------

/** What a runner reads first: the server's version and where the panel is for the device flow. */
export const infoResponseSchema = z.strictObject({
  protocolMajor: z.number().int().nonnegative(),
  serverMinor: z.number().int().nonnegative(),
  supported: z.strictObject({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  /** The server's version: `ostra runner` installs the same one (ADR 0046). */
  serverVersion: z.string().min(1).max(64),
  /** The panel's address, where a member approves a device code (`/device`). */
  panelUrl: httpUrlSchema,
  /** The device flow's client ID (RFC 8628, through better-auth). */
  deviceClientId: z.string().min(1).max(128),
});
export type InfoResponse = z.infer<typeof infoResponseSchema>;

// ---------- POST /runner/v1/register ----------

/** An Ed25519 public key: its raw 32 bytes in base64url, without padding. */
export const ed25519PublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "a raw Ed25519 public key in base64url");

export const runnerOsSchema = z.strictObject({
  platform: z.enum(["linux", "darwin", "win32"]),
  arch: z.string().min(1).max(32),
  release: z.string().max(128),
});
export type RunnerOs = z.infer<typeof runnerOsSchema>;

/**
 * A runner's first contact. It proves who sent it one of two ways:
 * - a personal runner sends the member's device session as `Authorization: Bearer <session>`, and
 *   no `joinToken`. The server creates a personal runner owned by that member, in the session's
 *   active organization, then revokes the session (ADR 0029, Q115).
 * - a pool runner sends its pool's join token in `joinToken` (milestone 1: only the default pool's
 *   bootstrap token that core writes at first start).
 */
export const registerRequestSchema = z.strictObject({
  publicKey: ed25519PublicKeySchema,
  name: z.string().min(1).max(128),
  executor: executorKindSchema,
  capacity: z.number().int().positive().max(1024),
  labels: z.array(runnerLabelSchema).max(64),
  os: runnerOsSchema,
  version: z.string().min(1).max(64),
  joinToken: z.string().min(1).max(512).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = z.strictObject({
  runnerId: runnerIdSchema,
  kind: runnerKindSchema,
  /** The pool a pool runner joined; `null` for a personal runner. */
  poolId: poolIdSchema.nullable(),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

// ---------- POST /runner/v1/token ----------

const TOKEN_ASSERTION_TAG = "ostra-runner-token-v1";

/**
 * A runner's signed assertion, traded for a short-lived access token.
 *
 * The signature is Ed25519, by the runner's private key, over the UTF-8 bytes of this canonical
 * string, four lines joined by a single `\n`, with no trailing newline:
 *
 *     ostra-runner-token-v1
 *     <runnerId>
 *     <issuedAt, as a base-10 integer of ms since the epoch>
 *     <nonce>
 *
 * The signature is sent in base64url without padding (86 characters). The server refuses an
 * `issuedAt` more than `runnerLimits.assertionSkewMs` from its clock, and a nonce it has seen.
 */
export const tokenAssertionSchema = z
  .strictObject({
    runnerId: runnerIdSchema,
    issuedAt: epochMsSchema,
    /** 16 to 64 random bytes in base64url: makes each assertion single-use. */
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,86}$/, "16 to 64 random bytes in base64url"),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, "an Ed25519 signature in base64url"),
  })
  .describe(
    "Ed25519 signature over 'ostra-runner-token-v1\\n<runnerId>\\n<issuedAt>\\n<nonce>' (UTF-8, no trailing newline), base64url.",
  );
export type TokenAssertion = z.infer<typeof tokenAssertionSchema>;

/** The exact string a runner signs and the server verifies (see `tokenAssertionSchema`). */
export const tokenAssertionCanonicalString = (
  assertion: Pick<TokenAssertion, "runnerId" | "issuedAt" | "nonce">,
): string =>
  [TOKEN_ASSERTION_TAG, assertion.runnerId, String(assertion.issuedAt), assertion.nonce].join("\n");

export const tokenResponseSchema = z.strictObject({
  /** Sent at the WebSocket upgrade as `Authorization: Bearer <accessToken>`. Never logged. */
  accessToken: z.string().min(1).max(4096),
  expiresAt: epochMsSchema,
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

// ---------- GET /runner/v1/tasks/:taskId/spec and POST .../credentials ----------

/** `?leaseEpoch=<n>` on the spec request. */
export const taskSpecQuerySchema = z.strictObject({
  leaseEpoch: z.coerce.number().pipe(leaseEpochSchema),
});
export type TaskSpecQuery = z.infer<typeof taskSpecQuerySchema>;

export const taskSpecResponseSchema = taskSpecSchema;

/**
 * The credentials request. The server answers only when `leaseEpoch` is the task's current one
 * and its grace hasn't ended; otherwise `409` with `stale-lease` and `currentEpoch`.
 */
export const taskCredentialsRequestSchema = z.strictObject({
  taskId: taskIdSchema,
  leaseEpoch: leaseEpochSchema,
});
export type TaskCredentialsRequest = z.infer<typeof taskCredentialsRequestSchema>;

export const taskCredentialsResponseSchema = taskCredentialsSchema;

// ---------- the HTTP fallback carrier (milestone 5) ----------

const frameArrayBodySchema = z.strictObject({ frames: z.array(z.unknown()).max(512) });

const parseFrameArray = <Frame>(
  value: unknown,
  parseOne: (item: unknown) => { readonly ok: true; readonly frame: Frame } | { readonly ok: false; readonly error: { readonly detail: string } },
): { readonly ok: true; readonly frames: readonly Frame[] } | { readonly ok: false; readonly detail: string } => {
  const body = frameArrayBodySchema.safeParse(value);
  if (!body.success) {
    return { ok: false, detail: "the body is not { frames: [...] } with at most 512 frames" };
  }
  const frames: Frame[] = [];
  for (const [index, item] of body.data.frames.entries()) {
    const parsed = parseOne(item);
    if (!parsed.ok) {
      return { ok: false, detail: `frames.${String(index)}: ${parsed.error.detail}` };
    }
    frames.push(parsed.frame);
  }
  return { ok: true, frames };
};

// `POST /runner/v1/hello` is the handshake that `hello` and `welcome` do on a WebSocket: its body
// is the `hello` frame, and its answer is `welcome` or `error`.

/** `POST /runner/v1/up`: a batch of up frames at the negotiated minor (`x-ostra-minor`). */
export const parseHttpUpBody = (
  value: unknown,
  minor: number,
): { readonly ok: true; readonly frames: readonly UpFrame[] } | { readonly ok: false; readonly detail: string } =>
  parseFrameArray(value, (item) => upFrameCodec.parseValue(item, minor));

/** `GET /runner/v1/down?after=<seq>`: held up to `runnerLimits.longPollMs`, then frames or `204`. */
export const parseHttpDownBody = (
  value: unknown,
  minor: number,
): { readonly ok: true; readonly frames: readonly DownFrame[] } | { readonly ok: false; readonly detail: string } =>
  parseFrameArray(value, (item) => downFrameCodec.parseValue(item, minor));

export const httpDownQuerySchema = z.strictObject({
  after: z.coerce.number().pipe(z.number().int().nonnegative()),
});
