import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import type { Clock } from "@ostra/domain";
import {
  blobChunkQuerySchema,
  blobDownloadQuerySchema,
  blobIdSchema,
  blobUploadFinishRequestSchema,
  blobUploadStartRequestSchema,
  projectIdSchema,
  RUNNER_PATH_PREFIX,
  runnerLimits,
  taskIdSchema,
  uploadIdSchema,
} from "@ostra/protocol";
import type { BlobChunkResponse, BlobUploadFinishResponse, BlobUploadStartResponse, LeaseEpoch, OrganizationId, RunnerId, TaskId } from "@ostra/protocol";

import { bearerToken, runnerIsLive } from "../gateway/access-token.ts";
import type { AccessTokens } from "../gateway/access-token.ts";
import { checkTaskLease, isTaskToken } from "../gateway/task-token.ts";
import type { TaskTokens } from "../gateway/task-token.ts";
import { readBody, readJsonBody, sendError, sendJson } from "../http.ts";
import type { BlobScopeOwner, BlobService, BlobServiceError } from "./blob-service.ts";

// The runner's bulk path (ADR 0043, spec section 5.1, ticket 12): four endpoints beside the
// gateway, for session archives going up and ticket files coming down. Each checks the caller's
// token (a runner's access token, or a box's task token for its own task), that the task is
// leased to that runner at that epoch (409 `stale-lease` otherwise), and that a download names a
// blob of that task. Uploads are resumable and checked by their SHA-256. Bytes are never logged:
// log lines carry the task, the runner, the epoch, blob and upload IDs, sizes and digests.

const blobsPath = new RegExp(`^${RUNNER_PATH_PREFIX}/tasks/([^/]+)/blobs(?:/([^/]+))?(/finish)?$`);

export type BlobEndpointDeps = {
  readonly db: Db;
  readonly tokens: AccessTokens;
  readonly taskTokens: TaskTokens;
  readonly blobs: BlobService;
  readonly clock: Clock;
  readonly logger: Logger;
};

type Caller = { readonly runnerId: RunnerId; readonly organizationId: OrganizationId; readonly taskTokenEpoch: LeaseEpoch | null };

type LeaseCheck =
  | { readonly ok: true; readonly owner: BlobScopeOwner }
  | { readonly ok: false; readonly status: 404 | 409; readonly currentEpoch?: number };

/** The task is this caller's, leased to its runner at `epoch`, and that lease is active. */
const checkLease = async (db: Db, caller: Caller, taskId: TaskId, epoch: LeaseEpoch): Promise<LeaseCheck> => {
  const task = await db.task.findFirst({
    where: { id: taskId, organizationId: caller.organizationId },
    select: { leaseEpoch: true, projectId: true },
  });
  if (task === null) {
    return { ok: false, status: 404 };
  }
  const lease = await db.lease.findFirst({
    where: { taskId, organizationId: caller.organizationId, epoch, runnerId: caller.runnerId, state: "active" },
    select: { id: true },
  });
  if (lease === null || task.leaseEpoch !== epoch || (caller.taskTokenEpoch !== null && caller.taskTokenEpoch !== epoch)) {
    return { ok: false, status: 409, currentEpoch: task.leaseEpoch };
  }
  return {
    ok: true,
    owner: { organizationId: caller.organizationId, task: { projectId: projectIdSchema.parse(task.projectId), taskId } },
  };
};

const statusOf = (error: BlobServiceError): 400 | 404 | 409 | 413 | 503 => {
  switch (error) {
    case "too-large":
      return 413;
    case "not-found":
      return 404;
    case "offset-mismatch":
    case "digest-mismatch":
      return 409;
    case "bad-request":
      return 400;
    case "unavailable":
      return 503;
    default:
      return error satisfies never;
  }
};

const codeOf = (error: BlobServiceError): "too-large" | "not-found" | "offset-mismatch" | "digest-mismatch" | "bad-request" | "internal" => {
  switch (error) {
    case "too-large":
    case "not-found":
    case "offset-mismatch":
    case "digest-mismatch":
    case "bad-request":
      return error;
    case "unavailable":
      return "internal";
    default:
      return error satisfies never;
  }
};

export const handleBlobEndpoint =
  (deps: BlobEndpointDeps) =>
  async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const match = blobsPath.exec(url.pathname);
    if (match === null) {
      return false;
    }
    const [, rawTaskId, rawId, finish] = match;
    const taskId = taskIdSchema.safeParse(decodeURIComponent(rawTaskId ?? ""));
    if (!taskId.success) {
      sendError(response, 404, "not-found", "no such task");
      return true;
    }

    // Who's calling: a runner by its access token, or a box's sidecar by its task's token.
    const token = bearerToken(request.headers.authorization);
    let caller: Caller;
    if (token !== null && isTaskToken(token)) {
      const claims = deps.taskTokens.verify(token);
      if (claims === null) {
        sendError(response, 401, "unauthorized", "the task token is not valid");
        return true;
      }
      if (claims.taskId !== taskId.data) {
        sendError(response, 403, "unauthorized", "a task token is for its own task's blobs only");
        return true;
      }
      const check = await checkTaskLease(deps.db, claims);
      if (!check.ok) {
        if (check.error === "not-found") {
          sendError(response, 404, "not-found", "no such task");
        } else {
          sendError(response, 409, "stale-lease", "this task token's lease has ended", { currentEpoch: check.currentEpoch });
        }
        return true;
      }
      caller = { runnerId: claims.runnerId, organizationId: claims.organizationId, taskTokenEpoch: claims.leaseEpoch };
    } else {
      const claims = token === null ? null : deps.tokens.verify(token, deps.clock.now());
      if (claims === null) {
        sendError(response, 401, "unauthorized", "a valid access token is required");
        return true;
      }
      if (!(await runnerIsLive(deps.db, claims))) {
        sendError(response, 403, "unauthorized", "this runner is revoked; register it again");
        return true;
      }
      caller = { runnerId: claims.runnerId, organizationId: claims.organizationId, taskTokenEpoch: null };
    }
    const logger = deps.logger.child({ component: "blob-endpoints", taskId: taskId.data, runnerId: caller.runnerId });

    const leaseOr409 = async (epoch: LeaseEpoch): Promise<BlobScopeOwner | null> => {
      const lease = await checkLease(deps.db, caller, taskId.data, epoch);
      if (lease.ok) {
        return lease.owner;
      }
      if (lease.status === 404) {
        sendError(response, 404, "not-found", "no such task");
      } else {
        logger.info("blob.stale-lease", { leaseEpoch: epoch, currentEpoch: lease.currentEpoch ?? null });
        sendError(response, 409, "stale-lease", "this runner holds no current lease of the task at that epoch", {
          ...(lease.currentEpoch === undefined ? {} : { currentEpoch: lease.currentEpoch }),
        });
      }
      return null;
    };

    const fail = (error: BlobServiceError, message: string): void => {
      sendError(response, statusOf(error), codeOf(error), message);
    };

    // ---------- POST .../blobs: start or resume ----------
    if (rawId === undefined && finish === undefined && request.method === "POST") {
      const body = await readJsonBody(request, 4 * 1024);
      const parsed = body.ok ? blobUploadStartRequestSchema.safeParse(body.value) : undefined;
      if (parsed?.success !== true) {
        // A size over the protocol's cap fails the schema: say so in the cap's words.
        sendError(response, 400, "bad-request", "the body is not a blob upload start (a size over the blob cap is refused)");
        return true;
      }
      const owner = await leaseOr409(parsed.data.leaseEpoch);
      if (owner === null) {
        return true;
      }
      const started = await deps.blobs.startUpload(owner, {
        purpose: parsed.data.purpose,
        sha256: parsed.data.sha256,
        size: parsed.data.size,
        contentType: parsed.data.contentType,
      });
      if (!started.ok) {
        logger.info("blob.start-refused", { leaseEpoch: parsed.data.leaseEpoch, size: parsed.data.size, error: started.error });
        fail(started.error, started.message);
        return true;
      }
      const answer: BlobUploadStartResponse = started.value;
      sendJson(response, 200, answer);
      return true;
    }

    const id = rawId === undefined ? undefined : decodeURIComponent(rawId);

    // ---------- PUT .../blobs/:uploadId?offset=&leaseEpoch=: one chunk ----------
    if (id !== undefined && finish === undefined && request.method === "PUT") {
      const uploadId = uploadIdSchema.safeParse(id);
      const query = blobChunkQuerySchema.safeParse({ offset: url.searchParams.get("offset"), leaseEpoch: url.searchParams.get("leaseEpoch") });
      if (!uploadId.success || !query.success) {
        sendError(response, 400, "bad-request", "a chunk needs its upload, offset and leaseEpoch");
        return true;
      }
      const owner = await leaseOr409(query.data.leaseEpoch);
      if (owner === null) {
        return true;
      }
      const chunk = await readBody(request, runnerLimits.uploadChunkMaxBytes);
      if (chunk === "too-large") {
        sendError(response, 413, "too-large", `a chunk is at most ${String(runnerLimits.uploadChunkMaxBytes)} bytes`);
        return true;
      }
      if (chunk === "timeout") {
        sendError(response, 400, "bad-request", "the chunk did not arrive in time");
        return true;
      }
      const appended = await deps.blobs.appendUpload(owner, uploadId.data, query.data.offset, chunk);
      if (!appended.ok) {
        logger.info("blob.chunk-refused", { uploadId: uploadId.data, offset: query.data.offset, size: chunk.length, error: appended.error });
        fail(appended.error, appended.message);
        return true;
      }
      const answer: BlobChunkResponse = appended.value;
      sendJson(response, 200, answer);
      return true;
    }

    // ---------- POST .../blobs/:uploadId/finish ----------
    if (id !== undefined && finish !== undefined && request.method === "POST") {
      const uploadId = uploadIdSchema.safeParse(id);
      const body = await readJsonBody(request, 1024);
      const parsed = body.ok ? blobUploadFinishRequestSchema.safeParse(body.value) : undefined;
      if (!uploadId.success || parsed?.success !== true) {
        sendError(response, 400, "bad-request", "the body is not a blob upload finish");
        return true;
      }
      const owner = await leaseOr409(parsed.data.leaseEpoch);
      if (owner === null) {
        return true;
      }
      const finished = await deps.blobs.finishUpload(owner, uploadId.data);
      if (!finished.ok) {
        logger.info("blob.finish-refused", { uploadId: uploadId.data, error: finished.error });
        fail(finished.error, finished.message);
        return true;
      }
      logger.info("blob.uploaded", { uploadId: uploadId.data, blobId: finished.value.blobId, size: finished.value.size, sha256: finished.value.sha256 });
      const answer: BlobUploadFinishResponse = finished.value;
      sendJson(response, 200, answer);
      return true;
    }

    // ---------- GET .../blobs/:blobId?leaseEpoch=: the bytes, only for a blob of this task ----------
    if (id !== undefined && finish === undefined && request.method === "GET") {
      const blobId = blobIdSchema.safeParse(id);
      const query = blobDownloadQuerySchema.safeParse({ leaseEpoch: url.searchParams.get("leaseEpoch") });
      if (!blobId.success || !query.success) {
        sendError(response, 400, "bad-request", "a download needs its blob and leaseEpoch");
        return true;
      }
      const owner = await leaseOr409(query.data.leaseEpoch);
      if (owner === null) {
        return true;
      }
      const read = await deps.blobs.read(owner.organizationId, blobId.data, taskId.data);
      if (!read.ok) {
        logger.info("blob.download-refused", { blobId: blobId.data, error: read.error });
        fail(read.error, read.error === "not-found" ? "no such blob for this task" : read.message);
        return true;
      }
      logger.info("blob.downloaded", { blobId: blobId.data, size: read.value.size, sha256: read.value.sha256 });
      response.writeHead(200, {
        "content-type": read.value.contentType,
        "content-length": String(read.value.bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-ostra-sha256": read.value.sha256,
      });
      response.end(read.value.bytes);
      return true;
    }

    sendError(response, 404, "not-found", "no such route");
    return true;
  };
