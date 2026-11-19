import { z } from "zod";

import { poolIdSchema, runnerIdSchema, snapshotIdSchema, taskIdSchema } from "../ids.ts";
import {
  epochMsSchema,
  executorKindSchema,
  httpUrlSchema,
  leaseEpochSchema,
  runnerKindSchema,
  runnerLabelSchema,
} from "../common.ts";
import { snapshotCredentialsSchema, taskCredentialsSchema } from "../task/credentials.ts";
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
  /** `POST`: the task token a `docker` or `kubernetes` box's sidecar connects with (ADR 0034, Q129). */
  taskToken: (taskId: string): string => `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/token`,
  // The HTTP fallback carrier (milestone 5).
  httpHello: `${RUNNER_PATH_PREFIX}/hello`,
  httpUp: `${RUNNER_PATH_PREFIX}/up`,
  httpDown: `${RUNNER_PATH_PREFIX}/down`,
  // The bulk path (minor 1, ADR 0043): `blobs.ts` holds the bodies.
  /** `POST`: start or resume an upload. */
  taskBlobs: (taskId: string): string => `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/blobs`,
  /** `PUT ?offset=&leaseEpoch=`: one chunk. */
  taskBlobUpload: (taskId: string, uploadId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/blobs/${encodeURIComponent(uploadId)}`,
  /** `POST`: seal the upload, checking its size and digest. */
  taskBlobUploadFinish: (taskId: string, uploadId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/blobs/${encodeURIComponent(uploadId)}/finish`,
  /** `GET ?leaseEpoch=`: a blob of the task, as bytes. */
  taskBlob: (taskId: string, blobId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/blobs/${encodeURIComponent(blobId)}`,
  // Minor 2 (milestone 3).
  /** `POST`: a snapshot build's credentials, only for the runner the build was sent to (F-051). */
  snapshotCredentials: (snapshotId: string): string =>
    `${RUNNER_PATH_PREFIX}/snapshots/${encodeURIComponent(snapshotId)}/credentials`,
} as const;

/** Headers the HTTP carrier uses (ADR 0034). */
export const runnerHeaders = {
  /**
   * The negotiated minor, on every HTTP carrier request. Minor 1: also on the spec request, so
   * core answers in that minor's shape. Minor 2: also on the token request, with the runner's own
   * minor (nothing is negotiated yet), so core says why it refused (`tokenRefusalReasonSchema`).
   * A request without it is read as minor 0.
   */
  minor: "x-ostra-minor",
  /** The connection epoch from `welcome`; a newer connection answers `409`. */
  connectionEpoch: "x-ostra-connection-epoch",
  /**
   * Minor 1, on the bulk path's download (`GET .../blobs/:blobId`): the blob's SHA-256 in lower-case
   * hex, so the runner checks what it read. A ticket file's spec entry names no digest, so this is
   * where the runner gets it (ticket 26); an archive's is in the spec's restore section too.
   */
  blobSha256: "x-ostra-sha256",
} as const;

/** The minor a runner's HTTP request speaks: its `x-ostra-minor` header, or 0 when it's missing or bad. */
export const minorFromHeader = (value: string | null | undefined): number => {
  if (value === null || value === undefined || !/^\d{1,4}$/.test(value)) {
    return 0;
  }
  return Number(value);
};

/**
 * Minor 2: why `POST /runner/v1/token` refused an assertion, in the error body's `reason`. Core
 * names it to a runner whose request says minor 2 or later in `x-ostra-minor`, and leaves it out
 * for an older one (`encodeRunnerHttpErrorForMinor`). Only `revoked` and `unknown-key` are for good.
 */
export const tokenRefusalReasonSchema = z.enum([
  /**
   * 401. `issuedAt` is more than `runnerLimits.assertionSkewMs` from the server's clock; `serverTime`
   * says what the server's read. The runner retries with its backoff and connects once the clocks agree.
   */
  "clock-skew",
  /**
   * 401. No runner has this ID, or its key doesn't verify the signature: one answer for both, so
   * nothing about which runners exist leaks. The runner's identity is of no use on this server.
   */
  "unknown-key",
  /** 403. The runner was revoked: it registers again, with a new identity. */
  "revoked",
  /** 401. The nonce was used before, as when a proxy resends a request: the runner signs a fresh assertion. */
  "replayed",
]);
export type TokenRefusalReason = z.infer<typeof tokenRefusalReasonSchema>;

/** Any runner endpoint's error body. */
export const runnerHttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      ...protocolErrorCodeSchema.options,
      "not-found",
      "bad-request",
      "conflict",
      // Minor 1, the bulk path (ADR 0043):
      /** A chunk's `offset` isn't the bytes the upload holds: ask the start endpoint where to resume. */
      "offset-mismatch",
      /** The finished upload's size or SHA-256 isn't the one it started with. The upload is dropped. */
      "digest-mismatch",
      /** Over the blob cap, or a chunk over the chunk cap. */
      "too-large",
    ]),
    message: z.string().max(2000),
    currentEpoch: leaseEpochSchema.optional(),
    /** Minor 2, on the token endpoint's refusals: why. */
    reason: tokenRefusalReasonSchema.optional(),
    /** Minor 2, with `clock-skew`: the server's clock when it refused, in ms since the epoch. */
    serverTime: epochMsSchema.optional(),
  }),
});
export type RunnerHttpError = z.infer<typeof runnerHttpErrorSchema>;

/**
 * An error body as a runner at `minor` reads it. Every field is strict, so below minor 2 it goes
 * without the token refusal's `reason` and `serverTime`, and parses as it did in minor 1.
 */
export const encodeRunnerHttpErrorForMinor = (body: RunnerHttpError, minor: number): RunnerHttpError => {
  if (minor >= 2) {
    return body;
  }
  const { code, message, currentEpoch } = body.error;
  return { error: { code, message, ...(currentEpoch === undefined ? {} : { currentEpoch }) } };
};

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
 * `issuedAt` more than `runnerLimits.assertionSkewMs` from its clock, and a nonce it has seen. From
 * minor 2 its refusal names why, in `reason` (`tokenRefusalReasonSchema`).
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

/**
 * The spec at this build's minor. A minor-0 runner reads it with minor 0's schema, so core answers
 * it with `encodeTaskSpecForMinor` (`taskSpecResponseSchemaFor`, in `task/spec.ts`).
 */
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

// ---------- POST /runner/v1/snapshots/:snapshotId/credentials (minor 2) ----------

/**
 * A snapshot build's credentials request. The server answers only when the snapshot is building
 * and its `snapshot-build` command went to this runner; otherwise `409` with `conflict`.
 */
export const snapshotCredentialsRequestSchema = z.strictObject({ snapshotId: snapshotIdSchema });
export type SnapshotCredentialsRequest = z.infer<typeof snapshotCredentialsRequestSchema>;

export const snapshotCredentialsResponseSchema = snapshotCredentialsSchema;

// ---------- POST /runner/v1/tasks/:taskId/token (ADR 0034, "The task token", Q129) ----------

/**
 * The runner asks once, when it makes a `docker` or `kubernetes` box, with its own access token.
 * Core answers only the runner that holds the task's current, active lease at this epoch; a stale
 * epoch gets `409` with `stale-lease`, and a `host` lease gets `400` (its runner is its sidecar).
 */
export const taskTokenRequestSchema = z.strictObject({
  leaseEpoch: leaseEpochSchema,
});
export type TaskTokenRequest = z.infer<typeof taskTokenRequestSchema>;

/** The prefix of every task token, which the log guard redacts. */
export const TASK_TOKEN_PREFIX = "ostra-task-";

export const taskTokenResponseSchema = z.strictObject({
  /**
   * The box's sidecar connects, and reads its task's spec and credentials, with this as
   * `Authorization: Bearer <taskToken>`. Valid exactly as long as the lease is the task's current,
   * active one: it has no clock. The runner writes it to a file only the sidecar's container mounts;
   * it is never in an environment variable, an argument or a log line.
   */
  taskToken: z.string().startsWith(TASK_TOKEN_PREFIX).min(TASK_TOKEN_PREFIX.length + 1).max(4096),
});
export type TaskTokenResponse = z.infer<typeof taskTokenResponseSchema>;

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
