import { z } from "zod";

import { cliSessionIdSchema, taskIdSchema, ticketKeySchema } from "../ids.ts";
import { branchNameSchema, epochMsSchema, gitShaSchema, httpUrlSchema, repoFullNameSchema } from "../common.ts";

// The `ostra` CLI's HTTP on the web app (F-103, ADR 0051, protocol minor 2): `ostra login`'s
// device-code grant, `ostra checkout`'s branches and `ostra logout`. Request and response schemas
// only; the routes are the web app's (ticket 39) and the client is the CLI's (ticket 33).
//
// A CLI session is its own credential: a random token, sent as `Authorization: Bearer <token>`,
// that reads branch names and clone URLs and nothing else. Every route refuses a revoked or
// expired session with 401 and a message the CLI prints. ostra owns this format: strict.

/** The CLI's URL prefix on the web app. */
export const CLI_PATH_PREFIX = "/api/cli/v1";

/** Every CLI endpoint's path. */
export const cliPaths = {
  /** `POST`: start a device-code grant for a CLI session. */
  device: `${CLI_PATH_PREFIX}/device`,
  /** `POST`: poll the grant; the answer is the session's token once a member approved the code. */
  deviceToken: `${CLI_PATH_PREFIX}/device/token`,
  /** `GET`: a task's branches, by its ticket key, its ID or its URL. */
  taskBranches: (ref: string): string => `${CLI_PATH_PREFIX}/tasks/${encodeURIComponent(ref)}/branches`,
  /** `DELETE`: revoke the session the request is made with. */
  session: `${CLI_PATH_PREFIX}/session`,
} as const;

/** The panel page where a member approves the code, as for a runner (milestone 1's `/device`). */
export const CLI_DEVICE_PAGE = "/device";

/** A CLI session's token: shown to the CLI once, stored hashed. Never logged. */
export const cliSessionTokenSchema = z
  .string()
  .regex(/^ostra_cli_[A-Za-z0-9_-]{32,128}$/, "an ostra CLI session token")
  .describe("A CLI session's token. Never logged; stored only as a hash.");

/** The machine's name the CLI sends, for the panel's list of sessions. */
export const cliMachineNameSchema = z.string().trim().min(1).max(128);

// ---------- POST /api/cli/v1/device ----------

export const cliDeviceRequestSchema = z.strictObject({
  /** The machine's name, shown in "Account" and on the device page. */
  name: cliMachineNameSchema,
  /** The CLI's version, for the panel. */
  version: z.string().min(1).max(64),
});
export type CliDeviceRequest = z.infer<typeof cliDeviceRequestSchema>;

export const cliDeviceResponseSchema = z.strictObject({
  /** The grant's secret, sent back on each poll. Never printed or logged. */
  deviceCode: z.string().min(16).max(256),
  /** The code the member types or checks on the device page. */
  userCode: z.string().min(4).max(64),
  /** The device page. */
  verificationUrl: httpUrlSchema,
  /** The device page with the code filled in. */
  verificationUrlComplete: httpUrlSchema,
  expiresAt: epochMsSchema,
  /** How often the CLI polls, in seconds. */
  intervalSeconds: z.number().int().positive().max(60),
});
export type CliDeviceResponse = z.infer<typeof cliDeviceResponseSchema>;

// ---------- POST /api/cli/v1/device/token ----------

export const cliDeviceTokenRequestSchema = z.strictObject({ deviceCode: z.string().min(16).max(256) });
export type CliDeviceTokenRequest = z.infer<typeof cliDeviceTokenRequestSchema>;

/** The grant's answer once approved: the session, and its token, shown this once. */
export const cliDeviceTokenResponseSchema = z.strictObject({
  sessionId: cliSessionIdSchema,
  token: cliSessionTokenSchema,
  expiresAt: epochMsSchema,
  /** Who signed in, for the CLI's "Signed in as …" line. */
  username: z.string().min(1).max(128),
});
export type CliDeviceTokenResponse = z.infer<typeof cliDeviceTokenResponseSchema>;

/**
 * The grant's answer while it isn't approved (RFC 8628's codes), with `400`: keep polling on
 * `authorization-pending`, wait longer on `slow-down`, stop on the others.
 */
export const cliDeviceTokenErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["authorization-pending", "slow-down", "access-denied", "expired-token"]),
    message: z.string().max(2000),
  }),
});
export type CliDeviceTokenError = z.infer<typeof cliDeviceTokenErrorSchema>;

// ---------- GET /api/cli/v1/tasks/:ref/branches ----------

/** One repo of the task, as `ostra checkout` fetches it. No token: git uses the member's own access. */
export const cliTaskBranchRepoSchema = z.strictObject({
  fullName: repoFullNameSchema,
  cloneUrl: z.url({ protocol: /^https$/ }),
  branch: branchNameSchema,
  baseBranch: branchNameSchema,
  /** The branch's head after the last push, or `null` when nothing was pushed yet. */
  headSha: gitShaSchema.nullable(),
});
export type CliTaskBranchRepo = z.infer<typeof cliTaskBranchRepoSchema>;

export const cliTaskBranchesResponseSchema = z.strictObject({
  taskId: taskIdSchema,
  /** The ticket's key for a ticket task, `null` for a prompt task. */
  key: ticketKeySchema.nullable(),
  repos: z.array(cliTaskBranchRepoSchema).min(1),
});
export type CliTaskBranchesResponse = z.infer<typeof cliTaskBranchesResponseSchema>;

// ---------- DELETE /api/cli/v1/session ----------

/** `DELETE /session` answers `200` with this; the CLI then removes its file. */
export const cliSessionDeleteResponseSchema = z.strictObject({ revoked: z.literal(true) });
export type CliSessionDeleteResponse = z.infer<typeof cliSessionDeleteResponseSchema>;

// ---------- errors ----------

/**
 * Any CLI endpoint's error body. `401` carries `session-missing`, `session-expired` or
 * `session-revoked`, and its `message` is what the CLI prints, such as "This CLI session was
 * revoked. Run `ostra login` again."; `404` a task that doesn't exist or the member can't open.
 */
export const cliHttpErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["session-missing", "session-expired", "session-revoked", "not-found", "bad-request", "rate-limited"]),
    /** Words for the person at the terminal. Never holds a token. */
    message: z.string().min(1).max(2000),
  }),
});
export type CliHttpError = z.infer<typeof cliHttpErrorSchema>;
export type CliHttpErrorCode = CliHttpError["error"]["code"];

/** The messages the CLI prints for a refused session, shared by the server and the CLI's tests. */
export const cliSessionMessages = {
  "session-missing": "You're not signed in. Run `ostra login --server <url>` first.",
  "session-expired": "This CLI session expired. Run `ostra login` again.",
  "session-revoked": "This CLI session was revoked. Run `ostra login` again.",
} as const satisfies Readonly<Record<Extract<CliHttpErrorCode, `session-${string}`>, string>>;
