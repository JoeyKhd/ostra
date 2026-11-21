import { z } from "zod";

import {
  draftIdSchema,
  environmentProposalIdSchema,
  noteIdSchema,
  poolIdSchema,
  reviewRunIdSchema,
  runnerIdSchema,
  snapshotIdSchema,
  taskIdSchema,
} from "../ids.ts";
import {
  epochMsSchema,
  executorKindSchema,
  httpUrlSchema,
  leaseEpochSchema,
  runnerKindSchema,
  runnerLabelSchema,
} from "../common.ts";
import {
  memoryKindSchema,
  memoryNoteSchema,
  memoryNoteTitleSchema,
  memoryProposalInputSchema,
  memoryProposalRefSchema,
  memoryScopeSchema,
} from "../memory/notes.ts";
import { environmentProposalSchema, findingSchema, refineDraftSchema, reviewSummarySchema } from "../mcp/tools.ts";
import { snapshotCredentialsSchema, taskCredentialsSchema } from "../task/credentials.ts";
import { taskSpecSchema } from "../task/spec.ts";
import { errorFrameSchema, helloSchema, httpDownFrameCodec, protocolErrorCodeSchema, upFrameCodec } from "./messages.ts";
import { previewPaths } from "./preview.ts";
import type { DownFrame, UpFrame } from "./messages.ts";
import { runnerLimits } from "./limits.ts";
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
  // Minor 3 (milestone 4): the sidecar's memory tools, on behalf of one task, with its task token.
  /** `POST`: search the task's organization's and project's approved notes (F-110). */
  taskMemorySearch: (taskId: string): string => `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/memory/search`,
  /** `GET`: one approved note, in full (F-110). */
  taskMemoryNote: (taskId: string, noteId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/memory/notes/${encodeURIComponent(noteId)}`,
  /** `POST`: propose a note, for a member to approve (F-111). */
  taskMemoryProposals: (taskId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/memory/proposals`,
  // Minor 4 (milestone 5): the registry's short-lived credentials (F-120, ADR 0060).
  /** `POST`: the pull credential for the lease's snapshot image, for the runner that holds the lease. */
  taskPullCredential: (taskId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/pull-credential`,
  /** `POST`: the push credential for a snapshot build, for the runner the build was given to. */
  snapshotPushCredential: (snapshotId: string): string =>
    `${RUNNER_PATH_PREFIX}/snapshots/${encodeURIComponent(snapshotId)}/push-credential`,
  // Minor 5 (milestone 6): the sidecar's draft, review and proposal tools, with the task token.
  /** `POST`: a refine task's draft (F-099). */
  taskDraft: (taskId: string): string => `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/draft`,
  /** `POST`: a review task's review (F-100). */
  taskReview: (taskId: string): string => `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/review`,
  /** `POST`: an onboarding task's environment proposal (F-113). */
  taskEnvironmentProposal: (taskId: string): string =>
    `${RUNNER_PATH_PREFIX}/tasks/${encodeURIComponent(taskId)}/environment-proposal`,
  // Minor 7 (milestone 8, ADR 0068): the preview connection and the HTTP carrier's frames (`preview.ts`).
  /** `GET`, upgraded to a binary WebSocket: one view's connection, `?view=&leaseEpoch=`. */
  preview: previewPaths.connection,
  /** `POST`: a view's frames over the HTTP carrier, as a multipart body. */
  previewFrames: previewPaths.frames,
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
  /**
   * The connection epoch from `welcome`, on every HTTP carrier request after `POST /hello`; one
   * that isn't the runner's open connection is answered `409` (`httpEpochRefusal`, ADR 0034).
   */
  connectionEpoch: "x-ostra-epoch",
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

const minorWindowSchema = z.strictObject({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() });

/** Up to minor 3: what a runner reads first. Strict, so core answers a runner below minor 4 in this shape. */
export const infoResponseSchemaV3 = z.strictObject({
  protocolMajor: z.number().int().nonnegative(),
  serverMinor: z.number().int().nonnegative(),
  supported: minorWindowSchema,
  /** The server's version: `ostra runner` installs the same one (ADR 0046). */
  serverVersion: z.string().min(1).max(64),
  /** The panel's address, where a member approves a device code (`/device`). */
  panelUrl: httpUrlSchema,
  /** The device flow's client ID (RFC 8628, through better-auth). */
  deviceClientId: z.string().min(1).max(128),
});

/** Where the pin installs the server's version from (ADR 0034, "How a runner is pinned"). */
export const infoNpmSchema = z.strictObject({
  /** The CLI's package name, `ostra`. */
  package: z.string().min(1).max(214),
  /** The npm registry to install it from. `OSTRA_RUNNER_NPM_REGISTRY` overrides it. */
  registry: httpUrlSchema,
});
export type InfoNpm = z.infer<typeof infoNpmSchema>;

/**
 * What a runner reads first: the server's version, its minor window and where the panel is for the
 * device flow. Minor 4 adds `minorWindow` (the same window as `supported`, named for the pin) and
 * `npm`, which the pin reads (`null`: the server names no registry, and the runner's own setting
 * or npm's public one applies). The server's version is `serverVersion`, there since minor 0.
 *
 * Every version reads it before anything is negotiated, so from minor 4 the runner sends its own
 * minor in `x-ostra-minor`, and core sends the new fields only to a request whose header says 4 or
 * more (`encodeInfoForMinor`). A request without the header is read as minor 0.
 */
export const infoResponseSchema = infoResponseSchemaV3.extend({
  minorWindow: minorWindowSchema.optional(),
  npm: infoNpmSchema.nullable().optional(),
});
export type InfoResponse = z.infer<typeof infoResponseSchema>;

const infoStripV3 = z.object(infoResponseSchemaV3.shape);

/** The info answer as a runner at `minor` reads it: below minor 4, minor 3's fields only. */
export const encodeInfoForMinor = (info: InfoResponse, minor: number): InfoResponse =>
  minor >= 4 ? info : infoStripV3.parse(info);

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

// ---------- project memory (minor 3, milestone 4, ADR 0044) ----------

/**
 * `POST /tasks/:taskId/memory/search`: the agent's `memory_search`. Core searches only the
 * task's organization's and project's approved notes, with the query as a bound parameter. The
 * query is never logged.
 */
export const memorySearchRequestSchema = z
  .strictObject({
    query: z.string().trim().min(1).max(runnerLimits.memoryQueryMaxChars),
    limit: z.number().int().min(1).max(runnerLimits.memorySearchResultsMax),
  })
  .describe("A memory search. The query is never logged.");
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;

/** One result: the note's title and the line that matched, never its whole body. Never logged. */
export const memorySearchResultSchema = z.strictObject({
  noteId: noteIdSchema,
  title: memoryNoteTitleSchema,
  /** The best-matching line of the note. Never logged. */
  line: z.string().max(runnerLimits.memoryQueryMaxChars),
  kind: memoryKindSchema,
  scope: memoryScopeSchema,
});
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>;

export const memorySearchResponseSchema = z
  .strictObject({ results: z.array(memorySearchResultSchema).max(runnerLimits.memorySearchResultsMax) })
  .describe("A memory search's results. Their text is never logged.");
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;

/** `GET /tasks/:taskId/memory/notes/:noteId`: the agent's `memory_read`, one approved note. */
export const memoryNoteResponseSchema = memoryNoteSchema;
export type MemoryNoteResponse = z.infer<typeof memoryNoteResponseSchema>;

/** `POST /tasks/:taskId/memory/proposals`: the agent's `memory_propose`. Its text is never logged. */
export const memoryProposalRequestSchema = memoryProposalInputSchema;
export type MemoryProposalRequest = z.infer<typeof memoryProposalRequestSchema>;

/**
 * Why core refused a proposal, whose words the tool returns to the agent: a secret or a
 * model-control token was found (`found` names each kind, never the value), the task's
 * proposals reached their cap, or the input doesn't parse.
 */
export const memoryProposalRefusalSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("secret-found"),
    /** What was found, by kind, such as `a GitHub token` or `a model-control token`. Never the value. */
    found: z.array(z.string().min(1).max(100)).min(1).max(20),
  }),
  z.strictObject({ code: z.literal("limit-reached") }),
  z.strictObject({ code: z.literal("invalid") }),
]);
export type MemoryProposalRefusal = z.infer<typeof memoryProposalRefusalSchema>;

/** The proposal's answer: its ID, or a refusal. */
export const memoryProposalResponseSchema = z.union([memoryProposalRefSchema, memoryProposalRefusalSchema]);
export type MemoryProposalResponse = z.infer<typeof memoryProposalResponseSchema>;

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
  parseFrameArray(value, (item) => httpDownFrameCodec.parseValue(item, minor));

export const httpDownQuerySchema = z.strictObject({
  after: z.coerce.number().pipe(z.number().int().nonnegative()),
});

// ---------- the HTTP fallback carrier's bodies (minor 4, ADR 0034) ----------

/**
 * `POST /runner/v1/hello`: the body is the `hello` frame. It's answered `200` with
 * `{ frames: [welcome, ...acks] }` (`parseHttpDownBody`), or with `{ frames: [error] }` and the
 * status of the refusal. The access token is the `Authorization` header and is never logged.
 */
export const httpHelloRequestSchema = helloSchema;

/**
 * The HTTP carrier's answers. `POST /runner/v1/up`'s body is `{ frames: [...] }` of up frames
 * (`parseHttpUpBody`), sent with `x-ostra-epoch` and `x-ostra-minor`; it's answered `200` with
 * `{ frames: [...] }` of down frames, the acks, credit and errors the batch earned
 * (`parseHttpDownBody`). `GET /runner/v1/down?after=<seq>` is held up to `runnerLimits.longPollMs`,
 * then answered `200` with `{ frames: [...] }` of commands, or `204` with no body.
 */
export const httpCarrierStatus = {
  /** Frames in the body. */
  ok: 200,
  /** The long poll held its time and has nothing: poll again. */
  idle: 204,
  /** The request's connection isn't the runner's open one (`httpEpochRefusal`). */
  superseded: 409,
} as const;
export type HttpCarrierStatus = (typeof httpCarrierStatus)[keyof typeof httpCarrierStatus];

/**
 * The `409` body when a request's `x-ostra-epoch` isn't the runner's open connection, and core
 * closed it: quiet past the dead time. The runner sends `POST /hello` again. Below minor 8 it's also
 * the answer when a newer connection replaced it.
 */
export const httpSupersededSchema = z.strictObject({ code: z.literal("superseded") });
export type HttpSuperseded = z.infer<typeof httpSupersededSchema>;

/**
 * Minor 8 (ADR 0034, amended 2026-11-21): from this minor, a request whose connection a newer one of
 * the runner replaced, on either carrier, is answered `409` with the error `replaced`
 * (`runnerHttpErrorSchema`), the WebSocket's `evict` and 4409, so a runner on HTTP can tell it from
 * a connection core closed (`superseded`) and stops as it does on the WebSocket. A runner below it
 * is answered `superseded` for both, as before, and says hello again.
 */
export const HTTP_REPLACED_MINOR = 8;

/** Why a request's connection epoch was refused: a newer connection replaced it, or core closed it. */
export type HttpEpochRefusal = "replaced" | "closed";

/** The `409` body for a refused connection epoch, at the minor the request speaks (`x-ostra-minor`). */
export const httpEpochRefusal = (why: HttpEpochRefusal, minor: number): HttpSuperseded | RunnerHttpError =>
  why === "replaced" && minor >= HTTP_REPLACED_MINOR
    ? { error: { code: "replaced", message: "a newer connection of this runner took over" } }
    : { code: "superseded" };

/** A refused `POST /hello`: one `error` frame, at the server's minor. */
export const httpHelloRefusalSchema = z.strictObject({ frames: z.tuple([errorFrameSchema]) });
export type HttpHelloRefusal = z.infer<typeof httpHelloRefusalSchema>;

/** The connection epoch header's value: a positive integer, or `null` when it's missing or bad. */
export const connectionEpochFromHeader = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^[1-9]\d{0,14}$/.test(value)) {
    return null;
  }
  return Number(value);
};

// ---------- the registry's credentials (minor 4, F-120, ADR 0060) ----------

/**
 * `POST /tasks/:taskId/pull-credential`: the lease the pull is for. Core answers the runner that
 * holds the task's current lease at this epoch, for the image the lease's dispatch named.
 */
export const pullCredentialRequestSchema = z.strictObject({ leaseEpoch: leaseEpochSchema });
export type PullCredentialRequest = z.infer<typeof pullCredentialRequestSchema>;

/** `POST /snapshots/:snapshotId/push-credential`: no fields; the snapshot in the path names the build. */
export const pushCredentialRequestSchema = z.strictObject({});
export type PushCredentialRequest = z.infer<typeof pushCredentialRequestSchema>;

/**
 * A short-lived registry credential, for one pull or one build's push. The runner passes it to its
 * engine or a per-box pull secret, never to a container. The username and the token are never
 * logged, and never written to an event, a command, a pod's spec or an annotation.
 */
export const registryCredentialSchema = z
  .strictObject({
    /** The registry's host (and port), as an image reference names it. */
    registry: z.string().min(1).max(253),
    /** Never logged. */
    username: z.string().min(1).max(512),
    /** Never logged. */
    token: z.string().min(1).max(65_536),
    expiresAt: epochMsSchema,
  })
  .describe("A registry credential. The username and the token are never logged.");
export type RegistryCredential = z.infer<typeof registryCredentialSchema>;

export const pullCredentialResponseSchema = registryCredentialSchema;
export const pushCredentialResponseSchema = registryCredentialSchema;

/**
 * Why a credential request was refused, as `409` with this body:
 * - `no-image`: the lease's dispatch named no registry image (a pull)
 * - `not-the-builder`: the snapshot isn't building, or its build went to another runner (a push)
 * - `stale-lease`: the lease epoch isn't the task's current one (a pull), with `currentEpoch`
 */
export const registryCredentialRefusalSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["no-image", "not-the-builder", "stale-lease"]),
    message: z.string().max(2000),
    currentEpoch: leaseEpochSchema.optional(),
  }),
});
export type RegistryCredentialRefusal = z.infer<typeof registryCredentialRefusalSchema>;

// ---------- the sidecar's milestone 6 tools (minor 5, ADR 0028, ADR 0038, ADR 0058) ----------
//
// The sidecar's `submit_draft`, `submit_review` and `propose_environment`, on behalf of one task,
// with its task token. The shapes are `mcp/tools.ts`'s; a refusal's words are what the tool
// returns to the agent (`draftResultText`, `reviewResultText`, `environmentProposalResultText`).
// Nothing of a body is ever logged: counts and IDs only.

/** `POST /runner/v1/tasks/:taskId/draft`'s body: the draft. */
export const draftRequestSchema = refineDraftSchema;
export type DraftRequestBody = z.infer<typeof draftRequestSchema>;

/** `POST /runner/v1/tasks/:taskId/review`'s body: the summary and the findings, by repo ID. */
export const reviewRequestSchema = z
  .strictObject({ summary: reviewSummarySchema, findings: z.array(findingSchema).max(runnerLimits.reviewFindingsMax) })
  .describe("A review. Its text is never logged.");
export type ReviewRequestBody = z.infer<typeof reviewRequestSchema>;

/** `POST /runner/v1/tasks/:taskId/environment-proposal`'s body. */
export const environmentProposalRequestSchema = environmentProposalSchema;

/** Why core refused a draft: not a refine task, a draft that doesn't parse, or the task's drafts are at their cap. */
export const draftRefusalSchema = z.strictObject({ code: z.enum(["wrong-kind", "invalid", "limit-reached"]) });
export type DraftRefusal = z.infer<typeof draftRefusalSchema>;

/** A saved draft: its ID and its version within the task, from 1. */
export const draftSavedSchema = z.strictObject({ draftId: draftIdSchema, version: z.number().int().positive() });
export const draftResponseSchema = z.union([draftSavedSchema, draftRefusalSchema]);
export type DraftResponse = z.infer<typeof draftResponseSchema>;

/**
 * Why core refused a review: not a review task, a review that doesn't parse, the round already has
 * its review, or the code task is no longer in review.
 */
export const reviewRefusalSchema = z.strictObject({
  code: z.enum(["wrong-kind", "invalid", "limit-reached", "not-in-review"]),
});
export type ReviewRefusal = z.infer<typeof reviewRefusalSchema>;

export const reviewSavedSchema = z.strictObject({ reviewRunId: reviewRunIdSchema });
export const reviewResponseSchema = z.union([reviewSavedSchema, reviewRefusalSchema]);
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

/**
 * Why core refused a proposal: a secret's value was found (`found` names each kind, never the
 * value), not an onboarding task, or a proposal that doesn't parse.
 */
export const environmentProposalRefusalSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("secret-found"),
    /** What was found, by kind, such as `a GitHub token`. Never the value. */
    found: z.array(z.string().min(1).max(100)).min(1).max(20),
  }),
  z.strictObject({ code: z.literal("wrong-kind") }),
  z.strictObject({ code: z.literal("invalid") }),
]);
export type EnvironmentProposalRefusal = z.infer<typeof environmentProposalRefusalSchema>;

export const environmentProposalSavedSchema = z.strictObject({ proposalId: environmentProposalIdSchema });
export const environmentProposalResponseSchema = z.union([environmentProposalSavedSchema, environmentProposalRefusalSchema]);
export type EnvironmentProposalResponse = z.infer<typeof environmentProposalResponseSchema>;
