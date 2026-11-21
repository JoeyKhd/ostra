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
  /** `POST` (milestone 8, F-143): a one-time ticket for `ostra preview`'s tunnel to one of the task's previews. */
  previewTunnel: (ref: string): string => `${CLI_PATH_PREFIX}/tasks/${encodeURIComponent(ref)}/previews/tunnel`,
  /** `POST` (milestone 8, F-141): start a stopped task's app, with no agent turn, for `ostra preview`. */
  startApp: (ref: string): string => `${CLI_PATH_PREFIX}/tasks/${encodeURIComponent(ref)}/app/start`,
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

// ---------- `ostra preview` (milestone 8, protocol minor 7, F-143, ADR 0068) ----------
//
// `ostra preview <task> [port]` asks the web app for a one-time ticket, then opens core's
// `/cli/v1/tunnel?ticket=…`, whose WebSocket's messages are one HTTP/2 connection with the CLI as
// the client: each local TCP connection is one `CONNECT` stream through core to the box. Core is
// where runners already connect, so the member's machine reaches it the same way. A ticket is a
// bearer secret for 60 s and one use: never printed, logged or put in a process's arguments.

/** A CLI tunnel's ticket: single use, 60 s, bound to the member, the task, the port and the lease epoch. Never logged. */
export const cliTunnelTicketSchema = z
  .string()
  .regex(/^ostra_pt_[A-Za-z0-9_-]{32,128}$/, "an ostra preview ticket")
  .describe("A CLI tunnel's ticket. Never logged; stored only as a hash.");

/** `POST /api/cli/v1/tasks/:ref/previews/tunnel`: a port of the task's previews, or `null` for the primary's. */
export const cliPreviewTunnelRequestSchema = z.strictObject({
  port: z.number().int().min(1).max(65_535).nullable(),
});
export type CliPreviewTunnelRequest = z.infer<typeof cliPreviewTunnelRequestSchema>;

/** The ticket, where core is, and the port it opens, which the CLI serves on the same local port when it's free. */
export const cliPreviewTunnelGrantSchema = z.strictObject({
  /** Core's public address, which the CLI opens `/cli/v1/tunnel` on. */
  coreUrl: httpUrlSchema,
  ticket: cliTunnelTicketSchema,
  port: z.number().int().min(1).max(65_535),
});
export type CliPreviewTunnelGrant = z.infer<typeof cliPreviewTunnelGrantSchema>;

/**
 * Why no ticket was given: the task isn't there or isn't the member's to open (`not-found`, 404),
 * the port isn't one of its previews (`port-not-allowed`, 403), its runner can't tunnel (below
 * minor 7, or on the HTTP carrier: 409), or no box runs it (`no-box`, 409: start the app first).
 */
export const cliPreviewTunnelRefusalSchema = z.strictObject({
  code: z.enum(["not-found", "port-not-allowed", "runner-cannot-tunnel", "no-box"]),
});
export type CliPreviewTunnelRefusal = z.infer<typeof cliPreviewTunnelRefusalSchema>;

export const cliPreviewTunnelResponseSchema = z.union([cliPreviewTunnelGrantSchema, cliPreviewTunnelRefusalSchema]);
export type CliPreviewTunnelResponse = z.infer<typeof cliPreviewTunnelResponseSchema>;

/** The words the CLI prints for each refusal. `port` is the one the member asked for. */
export const cliPreviewTunnelRefusalWords = (refusal: CliPreviewTunnelRefusal, port: number | null): string => {
  switch (refusal.code) {
    case "not-found":
      return "No task by that name that you can open.";
    case "port-not-allowed":
      return port === null ? "This task has no preview to open." : `port ${String(port)} isn't one of this task's previews`;
    case "runner-cannot-tunnel":
      return "This task's runner can't open a tunnel: it needs protocol 1.7 or later, over a WebSocket. Use the preview pane in the panel.";
    case "no-box":
      return "Nothing runs for this task now. Start its app, then run this again.";
    default:
      return refusal.code satisfies never;
  }
};

/** `POST /api/cli/v1/tasks/:ref/app/start`: no body fields; the task's app starts with no agent turn. */
export const cliStartAppRequestSchema = z.strictObject({});
export type CliStartAppRequest = z.infer<typeof cliStartAppRequestSchema>;

/** The app's start: `starting` (a box is on its way, or its processes are starting) or `running` (it already was). */
export const cliStartAppStartedSchema = z.strictObject({ state: z.enum(["starting", "running"]) });

/**
 * Why the app didn't start: the task isn't there or the member's (`not-found`), it declares no app
 * process, no runner can take it now, or its runner is below minor 7.
 */
export const cliStartAppRefusalSchema = z.strictObject({
  code: z.enum(["not-found", "no-app-processes", "no-runner", "runner-needs-upgrade"]),
});
export type CliStartAppRefusal = z.infer<typeof cliStartAppRefusalSchema>;

export const cliStartAppResponseSchema = z.union([cliStartAppStartedSchema, cliStartAppRefusalSchema]);
export type CliStartAppResponse = z.infer<typeof cliStartAppResponseSchema>;

/** The words the CLI prints for each refusal. */
export const cliStartAppRefusalWords = (refusal: CliStartAppRefusal): string => {
  switch (refusal.code) {
    case "not-found":
      return "No task by that name that you can open.";
    case "no-app-processes":
      return "This task's environment declares no app process to start.";
    case "no-runner":
      return "No runner can take this task now. Try again when one is online.";
    case "runner-needs-upgrade":
      return "This task's runner needs protocol 1.7 or later to start its app: update the runner.";
    default:
      return refusal.code satisfies never;
  }
};

/** Core's tunnel path for the CLI (not the web app's): `GET`, upgraded to a binary WebSocket. */
export const CORE_CLI_TUNNEL_PATH = "/cli/v1/tunnel";

/** The tunnel's query: the ticket alone. Never logged, even in an access log. */
export const cliTunnelQuerySchema = z.strictObject({ ticket: cliTunnelTicketSchema });
export type CliTunnelQuery = z.infer<typeof cliTunnelQuerySchema>;

/** The WebSocket subprotocol the CLI asks core's tunnel for. */
export const CLI_TUNNEL_SUBPROTOCOL = "ostra-cli-tunnel.v1";

/**
 * Why core refused the CLI's tunnel before it upgraded, with the status (ticket 23):
 * - `bad-request` (400): no ticket, not the tunnel's subprotocol, or a browser's `Origin` (a page
 *   never opens it);
 * - `ticket-refused` (403): unknown, used, older than 60 s, or issued under an older lease;
 * - `not-found` (404): the task is gone, or the member can no longer open it;
 * - `port-not-allowed` (403): the port is no longer one of the task's previews;
 * - `runner-cannot-tunnel` (409), `no-box` (409): as the ticket's refusals;
 * - `not-connected` (409): the box's preview connection didn't reach the server in time;
 * - `forwarding-failed` (502): the server replica that holds the box's connection didn't answer.
 *
 * A ticket is used once the server reads it, so every retry asks for a new one.
 */
export const cliTunnelErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["bad-request", "ticket-refused", "not-found", "port-not-allowed", "runner-cannot-tunnel", "no-box", "not-connected", "forwarding-failed"]),
    /** Words for the person at the terminal (`cliTunnelErrorWords`). Never holds the ticket. */
    message: z.string().min(1).max(2000),
  }),
});
export type CliTunnelError = z.infer<typeof cliTunnelErrorSchema>;
export type CliTunnelErrorCode = CliTunnelError["error"]["code"];

/** The words for each of core's refusals of the tunnel, which core sends as the error's `message`. */
export const cliTunnelErrorWords = (code: CliTunnelErrorCode): string => {
  switch (code) {
    case "bad-request":
      return "The server refused this tunnel request: update the CLI.";
    case "ticket-refused":
      return "The preview's ticket was used, expired or is for an older box: run `ostra preview` again.";
    case "not-found":
      return "No task by that name that you can open.";
    case "port-not-allowed":
      return "That port is no longer one of this task's previews.";
    case "runner-cannot-tunnel":
      return cliPreviewTunnelRefusalWords({ code: "runner-cannot-tunnel" }, null);
    case "no-box":
      return "This task's box isn't running, or is idling out. Start its app, then run this again.";
    case "not-connected":
      return "The task's box didn't connect to the server in time. Trying again may work.";
    case "forwarding-failed":
      return "The server that holds the task's box didn't answer. Trying again may work.";
    default:
      return code satisfies never;
  }
};

/**
 * The WebSocket close codes core ends an open tunnel with (ticket 23), so the CLI says why and knows
 * whether a new ticket could help. A server that stops closes with 1001.
 */
export const cliTunnelCloseCodes = {
  /** The CLI session was revoked or expired, or the member can no longer open the task: no new ticket. */
  "session-ended": 4401,
  /** The view closed: its box idled out past the warm cap, or stopped. Start the app, then a new ticket. */
  "view-closed": 4410,
  /** The box's preview connection dropped, or a newer lease took the task: a new ticket may reach it. */
  "box-gone": 4404,
} as const satisfies Readonly<Record<string, number>>;
export type CliTunnelCloseReason = keyof typeof cliTunnelCloseCodes;

const cliTunnelCloseReasons = Object.keys(cliTunnelCloseCodes).filter((reason): reason is CliTunnelCloseReason => reason in cliTunnelCloseCodes);

/** The reason a close code stands for, or `null` for any other code. */
export const cliTunnelCloseReasonOf = (code: number): CliTunnelCloseReason | null => cliTunnelCloseReasons.find((reason) => cliTunnelCloseCodes[reason] === code) ?? null;

/** The words the CLI prints when the tunnel ends for `reason`. */
export const cliTunnelCloseWords = (reason: CliTunnelCloseReason): string => {
  switch (reason) {
    case "session-ended":
      return "This CLI session ended, or you can no longer open this task. Run `ostra login` again.";
    case "view-closed":
      return "The task's box stopped or idled out. Start its app, then run `ostra preview` again.";
    case "box-gone":
      return "The task's box dropped its connection to the server.";
    default:
      return reason satisfies never;
  }
};
