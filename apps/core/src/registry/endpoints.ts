import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { issuePullCredential, issuePushCredential } from "@ostra/domain";
import type { AuditLog, Clock, ServerAdapters } from "@ostra/domain";
import {
  leaseEpochSchema,
  pullCredentialRequestSchema,
  pushCredentialRequestSchema,
  registryCredentialSchema,
  RUNNER_PATH_PREFIX,
  snapshotIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { RegistryCredentialRefusal } from "@ostra/protocol";

import { bearerToken, runnerIsLive } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";

// The registry's credentials (protocol minor 4, F-120, ADR 0060; ticket 17), by the runner's own
// access token:
//
// - `POST /runner/v1/snapshots/:snapshotId/push-credential`: to the runner the build was given to,
//   while it builds.
// - `POST /runner/v1/tasks/:taskId/pull-credential`: to the runner holding the task's current lease
//   at the epoch it names, for the image the lease's box names.
//
// Each issuance is one audit entry (in the use case). A refusal is `409` with its code. Neither the
// credential nor the body is logged; a log line names the runner and the snapshot or the task.

const pushPath = new RegExp(`^${RUNNER_PATH_PREFIX}/snapshots/([^/]+)/push-credential$`);
const pullPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/pull-credential$`);

export type RegistryEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly adapters: Pick<ServerAdapters, "secretStore">;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
};

const refuse = (response: ServerResponse, code: RegistryCredentialRefusal["error"]["code"], message: string, currentEpoch?: number): void => {
  const body: RegistryCredentialRefusal = {
    error: { code, message, ...(currentEpoch === undefined ? {} : { currentEpoch: leaseEpochSchema.parse(currentEpoch) }) },
  };
  sendJson(response, 409, body);
};

export const handleRegistryEndpoint =
  (deps: RegistryEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const push = pushPath.exec(url.pathname);
    const pull = push === null ? pullPath.exec(url.pathname) : null;
    if (push === null && pull === null) {
      return false;
    }
    if (request.method !== "POST") {
      sendError(response, 404, "not-found", "no such route");
      return true;
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : deps.tokens.verify(token, deps.clock.now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a runner's access token is required");
      return true;
    }
    if (!(await runnerIsLive(deps.db, claims))) {
      sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
      return true;
    }
    const body = await readJsonBody(request, 1024);
    const ports = { audit: deps.audit, clock: deps.clock, adapters: deps.adapters };

    if (push !== null) {
      const snapshotId = snapshotIdSchema.safeParse(decodeURIComponent(push[1] ?? ""));
      if (!snapshotId.success || !body.ok || !pushCredentialRequestSchema.safeParse(body.value).success) {
        sendError(response, 400, "bad-request", "the request is not a push credential request");
        return true;
      }
      const logger = deps.logger.child({ component: "registry-endpoints", runnerId: claims.runnerId, snapshotId: snapshotId.data });
      const result = await deps.db.$transaction((tx) => issuePushCredential({ tx, ...ports }, { organizationId: claims.organizationId, runnerId: claims.runnerId, snapshotId: snapshotId.data }));
      if (result.ok) {
        logger.info("registry.push-credential-issued", {});
        sendJson(response, 200, registryCredentialSchema.parse(result.credential));
        return true;
      }
      logger.info("registry.push-credential-refused", { error: result.error });
      switch (result.error) {
        case "not-the-builder":
          refuse(response, "not-the-builder", result.message);
          return true;
        case "not-found":
          sendError(response, 404, "not-found", result.message);
          return true;
        default:
          return result satisfies never;
      }
    }

    const taskId = taskIdSchema.safeParse(decodeURIComponent(pull?.[1] ?? ""));
    const parsed = body.ok ? pullCredentialRequestSchema.safeParse(body.value) : undefined;
    if (!taskId.success || parsed?.success !== true) {
      sendError(response, 400, "bad-request", "the request is not a pull credential request");
      return true;
    }
    const logger = deps.logger.child({ component: "registry-endpoints", runnerId: claims.runnerId, taskId: taskId.data, leaseEpoch: parsed.data.leaseEpoch });
    const result = await deps.db.$transaction((tx) =>
      issuePullCredential({ tx, ...ports }, { organizationId: claims.organizationId, runnerId: claims.runnerId, taskId: taskId.data, leaseEpoch: parsed.data.leaseEpoch }),
    );
    if (result.ok) {
      logger.info("registry.pull-credential-issued", {});
      sendJson(response, 200, registryCredentialSchema.parse(result.credential));
      return true;
    }
    logger.info("registry.pull-credential-refused", { error: result.error });
    switch (result.error) {
      case "stale-lease": {
        const task = await deps.db.task.findFirst({ where: { id: taskId.data, organizationId: claims.organizationId }, select: { leaseEpoch: true } });
        refuse(response, "stale-lease", result.message, task === null || task.leaseEpoch < 1 ? undefined : task.leaseEpoch);
        return true;
      }
      case "no-image":
        refuse(response, "no-image", result.message);
        return true;
      case "not-found":
        sendError(response, 404, "not-found", result.message);
        return true;
      default:
        return result satisfies never;
    }
  };
