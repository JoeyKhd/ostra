import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import { createPanelBlobReadTokens, createPanelBlobTokens, DRAFT_IMAGE_MAX_BYTES, PANEL_BLOB_PATH, profileLimits, skillLimits } from "@ostra/domain";
import type { Clock, PanelBlobPurpose, PanelBlobReadTokens, PanelBlobResponse, PanelBlobTokens } from "@ostra/domain";
import { blobIdSchema } from "@ostra/protocol";

import { bearerToken } from "../gateway/access-token.ts";
import { readBody, sendError, sendJson } from "../http.ts";
import type { BlobService } from "./blob-service.ts";

// The panel's way to store a member's file (ADR 0043: core's blob service writes every blob; ticket
// 42, a skill's files). `POST /panel/v1/blobs` with the panel's token (`panel-blob-token.ts`: an HMAC
// over the organization, the purpose, the size and the SHA-256, good for a minute). The body must be
// exactly those bytes. The blob is the organization's, with no task: a profile's skill names it, and
// the dispatch copies it into each task that uses the skill. Bytes are never logged: lines carry the
// organization, the blob's ID, the size and the digest.
//
// And the panel's way to read one (a check's full output, a task's screenshot or recording, a
// library skill's file): `GET /panel/v1/blobs/<blobId>` with a read token for that blob of that
// organization, and of that task or of no task. The blob service reads it from whichever store its
// row names, through that store's adapter, so the panel serves every store the same. Core answers
// the bytes as `application/octet-stream`, never the type the blob was stored with: the panel sets
// each download's own fixed type.

export type PanelBlobEndpointDeps = {
  readonly blobs: Pick<BlobService, "put" | "read">;
  /** The secrets key's text, read when first needed: the key the panel signs with. */
  readonly secret: () => Promise<string>;
  readonly clock: Clock;
  readonly logger: Logger;
};

/**
 * What each purpose may hold, at most: a skill's file is the profile limit's, a draft's image 10
 * MiB, and a library skill's file the library's (milestone 8's ticket 30: the panel's install
 * writes each one through here, as the organization's blob with no task).
 */
const capOf = {
  "skill-file": profileLimits.skillFileMaxBytes,
  "draft-image": DRAFT_IMAGE_MAX_BYTES,
  "library-file": skillLimits.fileMaxBytes,
} as const satisfies Record<PanelBlobPurpose, number>;

export const handlePanelBlobEndpoint = (deps: PanelBlobEndpointDeps) => {
  const logger = deps.logger.child({ component: "panel-blob-endpoint" });
  let tokens: Promise<PanelBlobTokens> | undefined;
  const tokensOnce = (): Promise<PanelBlobTokens> => (tokens ??= deps.secret().then(createPanelBlobTokens));
  let readTokens: Promise<PanelBlobReadTokens> | undefined;
  const readTokensOnce = (): Promise<PanelBlobReadTokens> => (readTokens ??= deps.secret().then(createPanelBlobReadTokens));

  const serveRead = async (request: IncomingMessage, response: ServerResponse, idText: string): Promise<void> => {
    const blobId = blobIdSchema.safeParse(idText);
    if (request.method !== "GET" || !blobId.success) {
      sendError(response, 404, "not-found", "no such route");
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : (await readTokensOnce()).verify(token, deps.clock.now());
    if (claims?.blobId !== blobId.data) {
      sendError(response, 401, "unauthorized", "a valid panel read token for this blob is required");
      return;
    }
    const read = await deps.blobs.read(claims.organizationId, claims.blobId, claims.taskId);
    if (!read.ok) {
      logger.info("panel-blob.read-refused", { organizationId: claims.organizationId, taskId: claims.taskId, blobId: claims.blobId, error: read.error });
      switch (read.error) {
        case "not-found":
          sendError(response, 404, "not-found", "no such blob");
          break;
        case "unavailable":
        case "too-large":
        case "offset-mismatch":
        case "digest-mismatch":
        case "bad-request":
          sendError(response, 503, "internal", read.message);
          break;
        default:
          read.error satisfies never;
      }
      return;
    }
    logger.info("panel-blob.read", { organizationId: claims.organizationId, taskId: claims.taskId, blobId: claims.blobId, size: read.value.bytes.length, sha256: read.value.sha256 });
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(read.value.bytes.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(read.value.bytes);
  };

  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname.startsWith(`${PANEL_BLOB_PATH}/`)) {
      await serveRead(request, response, url.pathname.slice(PANEL_BLOB_PATH.length + 1));
      return true;
    }
    if (url.pathname !== PANEL_BLOB_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      sendError(response, 404, "not-found", "no such route");
      return true;
    }
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : (await tokensOnce()).verify(token, deps.clock.now());
    if (claims === null) {
      sendError(response, 401, "unauthorized", "a valid panel token is required");
      return true;
    }
    const cap = capOf[claims.purpose];
    if (claims.size > cap) {
      sendError(response, 413, "too-large", "the file is over the limit for its purpose");
      return true;
    }
    const body = await readBody(request, claims.size);
    if (body === "too-large") {
      sendError(response, 400, "bad-request", "the body is longer than the token's size");
      return true;
    }
    if (body === "timeout") {
      sendError(response, 400, "bad-request", "the body did not arrive in time");
      return true;
    }
    if (body.length !== claims.size || createHash("sha256").update(body).digest("hex") !== claims.sha256) {
      logger.info("panel-blob.mismatch", { organizationId: claims.organizationId, size: body.length });
      sendError(response, 400, "bad-request", "the body is not the bytes the token was made for");
      return true;
    }
    const stored = await deps.blobs.put({ organizationId: claims.organizationId, task: null }, { purpose: claims.purpose, contentType: "application/octet-stream", bytes: body });
    if (!stored.ok) {
      logger.info("panel-blob.refused", { organizationId: claims.organizationId, size: claims.size, error: stored.error });
      switch (stored.error) {
        case "too-large":
          sendError(response, 413, "too-large", stored.message);
          break;
        case "unavailable":
          sendError(response, 503, "internal", stored.message);
          break;
        case "not-found":
        case "offset-mismatch":
        case "digest-mismatch":
        case "bad-request":
          sendError(response, 400, "bad-request", stored.message);
          break;
        default:
          stored.error satisfies never;
      }
      return true;
    }
    logger.info("panel-blob.stored", { organizationId: claims.organizationId, purpose: claims.purpose, blobId: stored.value.blobId, size: stored.value.size, sha256: stored.value.sha256 });
    const answer: PanelBlobResponse = stored.value;
    sendJson(response, 200, answer);
    return true;
  };
};
