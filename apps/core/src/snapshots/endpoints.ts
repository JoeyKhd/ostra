import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { issueSnapshotCredentials } from "@ostra/domain";
import type { AuditLog, Clock, ServerAdapters } from "@ostra/domain";
import { RUNNER_PATH_PREFIX, snapshotCredentialsRequestSchema, snapshotIdSchema } from "@ostra/protocol";

import { bearerToken, runnerIsLive } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";

// `POST /runner/v1/snapshots/:snapshotId/credentials` (protocol minor 2, F-051, ticket 26): a
// snapshot build's read-only git tokens and setup secrets, for the runner the build went to while
// it builds, by the runner's own access token. A box's task token is never one: a build isn't a
// task's. The body is never logged; the log line names the snapshot and the runner.

const snapshotPath = new RegExp(`^${RUNNER_PATH_PREFIX}/snapshots/([^/]+)/credentials$`);

export type SnapshotEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly adapters: Pick<ServerAdapters, "codeHost" | "secretStore">;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly logger: Logger;
};

export const handleSnapshotEndpoint =
  (deps: SnapshotEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = snapshotPath.exec(url.pathname);
    if (match === null) {
      return false;
    }
    if (request.method !== "POST") {
      sendError(response, 404, "not-found", "no such route");
      return true;
    }
    const snapshotId = snapshotIdSchema.safeParse(decodeURIComponent(match[1] ?? ""));
    if (!snapshotId.success) {
      sendError(response, 404, "not-found", "no such snapshot");
      return true;
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : deps.tokens.verify(token, deps.clock.now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a runner's access token is required");
      return true;
    }
    const logger = deps.logger.child({ component: "snapshot-endpoints", snapshotId: snapshotId.data, runnerId: claims.runnerId });
    if (!(await runnerIsLive(deps.db, claims))) {
      logger.info("snapshot.runner-revoked", {});
      sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
      return true;
    }
    const body = await readJsonBody(request, 1024);
    const parsed = body.ok ? snapshotCredentialsRequestSchema.safeParse(body.value) : undefined;
    if (parsed?.success !== true || parsed.data.snapshotId !== snapshotId.data) {
      sendError(response, 400, "bad-request", "the body is not a credentials request for this snapshot");
      return true;
    }
    const result = await deps.db.$transaction(
      (tx) => issueSnapshotCredentials({ tx, audit: deps.audit, adapters: deps.adapters }, { snapshotId: snapshotId.data, runnerId: claims.runnerId }),
      { timeout: 30_000 },
    );
    if (result.ok) {
      logger.info("snapshot.credentials-issued", { repos: result.credentials.repos.length });
      sendJson(response, 200, result.credentials);
      return true;
    }
    logger.info("snapshot.credentials-refused", { error: result.error });
    switch (result.error) {
      case "conflict":
        sendError(response, 409, "conflict", result.message);
        return true;
      case "token-mint-failed":
        sendError(response, 502, "internal", result.message);
        return true;
      default:
        return result.error satisfies never;
    }
  };
