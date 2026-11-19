import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { issueTaskCredentials } from "@ostra/domain";
import type { AuditLog, Clock, ServerAdapters } from "@ostra/domain";
import {
  encodeTaskSpecForMinor,
  minorFromHeader,
  RUNNER_PATH_PREFIX,
  runnerHeaders,
  taskCredentialsRequestSchema,
  taskIdSchema,
  taskSpecQuerySchema,
} from "@ostra/protocol";
import type { LeaseEpoch, TaskId } from "@ostra/protocol";

import { bearerToken } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { buildTaskSpec } from "./task-spec.ts";

// The task endpoints beside the runner's WebSocket (ADR 0034, ticket 26): the spec and the
// credentials, each for the runner holding the task's current lease, authenticated by its access
// token. The credentials' body is never logged: the log line names the task, the runner and the
// epoch only.

/** The MCP token for one task and epoch: an HMAC under core's key. The `ostra-` prefix is redacted in logs. */
export const mcpTokenFor =
  (key: Buffer) =>
  (taskId: TaskId, leaseEpoch: LeaseEpoch): string => {
    const body = Buffer.from(JSON.stringify({ v: 1, t: taskId, e: leaseEpoch })).toString("base64url");
    return `ostra-mcp-${body}.${createHmac("sha256", key).update(`mcp\n${body}`).digest("base64url")}`;
  };

const taskPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/(spec|credentials)$`);

export type TaskEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore" | "modelProvider">;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly signingKey: Buffer;
  readonly logger: Logger;
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
    const claims = token === null ? null : deps.tokens.verify(token, deps.clock.now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a valid access token is required");
      return true;
    }
    const logger = deps.logger.child({ component: "task-endpoints", taskId: taskId.data, runnerId: claims.runnerId });

    if (which === "spec" && request.method === "GET") {
      const query = taskSpecQuerySchema.safeParse({ leaseEpoch: url.searchParams.get("leaseEpoch") });
      if (!query.success) {
        sendError(response, 400, "bad-request", "leaseEpoch is required");
        return true;
      }
      const result = await buildTaskSpec(
        { db: deps.db, codeHost: deps.adapters.codeHost, secretStore: deps.adapters.secretStore },
        { taskId: taskId.data, runnerId: claims.runnerId, leaseEpoch: query.data.leaseEpoch },
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
            { taskId: parsed.data.taskId, leaseEpoch: parsed.data.leaseEpoch, runnerId: claims.runnerId },
          ),
        { timeout: 30_000 },
      );
      if (result.ok) {
        logger.info("task.credentials-issued", { leaseEpoch: parsed.data.leaseEpoch, repos: result.credentials.repos.length });
        sendJson(response, 200, result.credentials);
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
