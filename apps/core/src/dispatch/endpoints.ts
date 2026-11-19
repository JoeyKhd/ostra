import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { issueTaskCredentials } from "@ostra/domain";
import type { AuditLog, Clock, ServerAdapters } from "@ostra/domain";
import {
  encodeTaskCredentialsForMinor,
  encodeTaskSpecForMinor,
  minorFromHeader,
  RUNNER_PATH_PREFIX,
  runnerHeaders,
  taskCredentialsRequestSchema,
  taskIdSchema,
  taskSpecQuerySchema,
  taskTokenRequestSchema,
  organizationIdSchema,
  boxIdSchema,
} from "@ostra/protocol";
import type { LeaseEpoch, RunnerId, TaskId, TaskTokenResponse } from "@ostra/protocol";

import { bearerToken, runnerIsLive } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { checkTaskLease, isTaskToken } from "../gateway/task-token.ts";
import type { TaskTokenClaims, TaskTokens } from "../gateway/task-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import type { BlobService } from "../blobs/blob-service.ts";
import { buildTaskSpec } from "./task-spec.ts";
import type { TaskSpecSettings } from "./task-spec.ts";

// The task endpoints beside the runner's WebSocket (ADR 0034, ticket 26): the spec and the
// credentials, each for the runner holding the task's current lease, authenticated by its access
// token. The credentials' body is never logged: the log line names the task, the runner and the
// epoch only.
//
// The task token (ADR 0034, Q129, ticket 41): `POST .../token` makes one for the runner that holds a
// `docker` or `kubernetes` lease, and the box's sidecar reads that task's spec and credentials with
// it. A boxed lease's credentials go to its task token only: the runner's own token is refused
// there, and still gets everything for a `host` lease, whose runner is its sidecar. The runner's
// token still reads a boxed task's spec, which holds no secret, to make the box.

/** The MCP token for one task and epoch: an HMAC under core's key. The `ostra-` prefix is redacted in logs. */
export const mcpTokenFor =
  (key: Buffer) =>
  (taskId: TaskId, leaseEpoch: LeaseEpoch): string => {
    const body = Buffer.from(JSON.stringify({ v: 1, t: taskId, e: leaseEpoch })).toString("base64url");
    return `ostra-mcp-${body}.${createHmac("sha256", key).update(`mcp\n${body}`).digest("base64url")}`;
  };

const taskPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/(spec|credentials|token)$`);

/** Who calls a task endpoint: a runner, by its access token, or a box's sidecar, by its task token. */
type Caller =
  | { readonly kind: "runner"; readonly runnerId: RunnerId }
  | { readonly kind: "sidecar"; readonly runnerId: RunnerId; readonly claims: TaskTokenClaims };

export type TaskEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore" | "modelProvider">;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly signingKey: Buffer;
  readonly logger: Logger;
  /** Milestone 2: what the spec tells a minor-1 runner (the idle timer, the spend cap). */
  readonly specSettings?: TaskSpecSettings;
  /** Milestone 3: copies a profile's skills into the blob store for the spec (ticket 16). */
  readonly blobs?: Pick<BlobService, "put" | "read">;
};

export const handleTaskEndpoint =
  (deps: TaskEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = taskPath.exec(url.pathname);
    if (match === null) {
      return false;
    }
    const [, rawTaskId, which] = match;
    const taskId = taskIdSchema.safeParse(decodeURIComponent(rawTaskId ?? ""));
    if (!taskId.success) {
      sendError(response, 404, "not-found", "no such task");
      return true;
    }
    const token = bearerToken(request.headers.authorization);
    let caller: Caller;
    if (token !== null && isTaskToken(token)) {
      const taskClaims = deps.taskTokens.verify(token);
      if (taskClaims === null) {
        sendError(response, 401, "unauthorized", "the task token is not valid");
        return true;
      }
      if (taskClaims.taskId !== taskId.data || which === "token") {
        sendError(response, 403, "unauthorized", "a task token is for its own task's spec and credentials only");
        return true;
      }
      // Every use reads the lease: a token whose lease ended gets the stale-lease answer.
      const check = await checkTaskLease(deps.db, taskClaims);
      if (!check.ok) {
        if (check.error === "not-found") {
          sendError(response, 404, "not-found", "no such task");
        } else {
          sendError(response, 409, "stale-lease", "this task token's lease has ended", { currentEpoch: check.currentEpoch });
        }
        return true;
      }
      caller = { kind: "sidecar", runnerId: taskClaims.runnerId, claims: taskClaims };
    } else {
      const claims = token === null ? null : deps.tokens.verify(token, deps.clock.now());
      if (claims === null) {
        sendError(response, 401, "unauthorized", "a valid access token is required");
        return true;
      }
      // A revoked runner's token is refused, though its 10 minutes may not be over (Q131). A task
      // token needs no such check: a revoke ends the runner's leases, and the lease check sees it.
      if (!(await runnerIsLive(deps.db, claims))) {
        deps.logger.child({ component: "task-endpoints", taskId: taskId.data, runnerId: claims.runnerId }).info("task.runner-revoked", {});
        sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
        return true;
      }
      caller = { kind: "runner", runnerId: claims.runnerId };
    }
    const logger = deps.logger.child({ component: "task-endpoints", taskId: taskId.data, runnerId: caller.runnerId, peer: caller.kind });

    if (which === "token" && request.method === "POST" && caller.kind === "runner") {
      const body = await readJsonBody(request, 1024);
      const parsed = body.ok ? taskTokenRequestSchema.safeParse(body.value) : undefined;
      if (parsed?.success !== true) {
        sendError(response, 400, "bad-request", "the body is not a task token request");
        return true;
      }
      const leaseEpoch = parsed.data.leaseEpoch;
      const task = await deps.db.task.findFirst({ where: { id: taskId.data }, select: { organizationId: true, leaseEpoch: true } });
      const runner = await deps.db.runner.findFirst({ where: { id: caller.runnerId }, select: { organizationId: true } });
      if (task === null || task.organizationId !== runner?.organizationId) {
        sendError(response, 404, "not-found", "no such task");
        return true;
      }
      const lease = await deps.db.lease.findFirst({
        where: { taskId: taskId.data, organizationId: task.organizationId, epoch: leaseEpoch, runnerId: caller.runnerId, state: "active" },
        select: { boxId: true, box: { select: { executor: true } } },
      });
      if (lease === null || task.leaseEpoch !== leaseEpoch) {
        sendError(response, 409, "stale-lease", "this runner holds no current lease of the task at that epoch", { currentEpoch: task.leaseEpoch });
        return true;
      }
      if (lease.box.executor === "host") {
        sendError(response, 400, "bad-request", "a host lease has no sidecar: its runner uses its own token");
        return true;
      }
      const issued: TaskTokenResponse = {
        taskToken: deps.taskTokens.issue({
          organizationId: organizationIdSchema.parse(task.organizationId),
          taskId: taskId.data,
          leaseEpoch,
          boxId: boxIdSchema.parse(lease.boxId),
          runnerId: caller.runnerId,
        }),
      };
      logger.info("task.token-issued", { leaseEpoch, boxId: lease.boxId });
      sendJson(response, 200, issued);
      return true;
    }

    if (which === "spec" && request.method === "GET") {
      const query = taskSpecQuerySchema.safeParse({ leaseEpoch: url.searchParams.get("leaseEpoch") });
      if (!query.success) {
        sendError(response, 400, "bad-request", "leaseEpoch is required");
        return true;
      }
      if (caller.kind === "sidecar" && query.data.leaseEpoch !== caller.claims.leaseEpoch) {
        sendError(response, 409, "stale-lease", "the task token is for another epoch", { currentEpoch: caller.claims.leaseEpoch });
        return true;
      }
      const result = await buildTaskSpec(
        {
          db: deps.db,
          codeHost: deps.adapters.codeHost,
          secretStore: deps.adapters.secretStore,
          ...(deps.specSettings === undefined ? {} : { settings: deps.specSettings }),
          ...(deps.blobs === undefined ? {} : { blobs: deps.blobs }),
        },
        { taskId: taskId.data, runnerId: caller.runnerId, leaseEpoch: query.data.leaseEpoch },
      );
      if (result.ok) {
        // A minor-0 runner sends no minor header, and gets minor 0's shape (protocol minor 1).
        const header = request.headers[runnerHeaders.minor];
        const minor = minorFromHeader(typeof header === "string" ? header : undefined);
        logger.info("task.spec-sent", { leaseEpoch: query.data.leaseEpoch, minor });
        sendJson(response, 200, encodeTaskSpecForMinor(result.spec, minor));
        return true;
      }
      switch (result.error) {
        case "not-found":
          sendError(response, 404, "not-found", result.message);
          return true;
        case "stale-lease":
          sendError(response, 409, "stale-lease", result.message, { currentEpoch: result.currentEpoch });
          return true;
        case "code-host-failed":
          sendError(response, 502, "internal", result.message);
          return true;
        case "profile-unusable":
          logger.warn("task.spec-refused", { leaseEpoch: query.data.leaseEpoch, error: result.error });
          sendError(response, 500, "internal", result.message);
          return true;
        default:
          return result satisfies never;
      }
    }

    if (which === "credentials" && request.method === "POST") {
      const body = await readJsonBody(request, 4 * 1024);
      const parsed = body.ok ? taskCredentialsRequestSchema.safeParse(body.value) : undefined;
      if (parsed?.success !== true || parsed.data.taskId !== taskId.data) {
        sendError(response, 400, "bad-request", "the body is not a credentials request for this task");
        return true;
      }
      if (caller.kind === "sidecar" && parsed.data.leaseEpoch !== caller.claims.leaseEpoch) {
        sendError(response, 409, "stale-lease", "the task token is for another epoch", { currentEpoch: caller.claims.leaseEpoch });
        return true;
      }
      if (caller.kind === "runner") {
        // A boxed lease's credentials reach its sidecar alone, through its task token (Q129).
        const boxed = await deps.db.lease.findFirst({
          where: { taskId: parsed.data.taskId, epoch: parsed.data.leaseEpoch, runnerId: caller.runnerId },
          select: { box: { select: { executor: true } } },
        });
        if (boxed !== null && boxed.box.executor !== "host") {
          logger.info("task.credentials-refused", { leaseEpoch: parsed.data.leaseEpoch, error: "boxed-lease-needs-task-token" });
          sendError(response, 403, "unauthorized", "a docker or kubernetes box's credentials go to its sidecar's task token only");
          return true;
        }
      }
      const result = await deps.db.$transaction(
        (tx) =>
          issueTaskCredentials(
            {
              tx,
              audit: deps.audit,
              clock: deps.clock,
              adapters: deps.adapters,
              mcpToken: mcpTokenFor(deps.signingKey),
            },
            { taskId: parsed.data.taskId, leaseEpoch: parsed.data.leaseEpoch, runnerId: caller.runnerId },
          ),
        { timeout: 30_000 },
      );
      if (result.ok) {
        logger.info("task.credentials-issued", { leaseEpoch: parsed.data.leaseEpoch, repos: result.credentials.repos.length });
        // Minor 2 adds the MCP servers' headers; a runner below it sends no such header and gets minor 1's shape.
        const header = request.headers[runnerHeaders.minor];
        const minor = minorFromHeader(typeof header === "string" ? header : undefined);
        sendJson(response, 200, encodeTaskCredentialsForMinor(result.credentials, minor));
        return true;
      }
      logger.info("task.credentials-refused", { leaseEpoch: parsed.data.leaseEpoch, error: result.error });
      switch (result.error) {
        case "not-found":
          sendError(response, 404, "not-found", result.message);
          return true;
        case "stale-lease":
          sendError(response, 409, "stale-lease", result.message, { currentEpoch: result.currentEpoch });
          return true;
        case "provider-not-allowed-on-personal-runners":
          sendError(response, 403, "unauthorized", result.message);
          return true;
        case "token-mint-failed":
          sendError(response, 502, "internal", result.message);
          return true;
        default:
          return result satisfies never;
      }
    }
    sendError(response, 404, "not-found", "no such route");
    return true;
  };
