import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import { createPanelBlobTokens, DRAFT_IMAGE_MAX_BYTES, PANEL_BLOB_PATH, profileLimits } from "@ostra/domain";
import type { Clock, PanelBlobPurpose, PanelBlobResponse, PanelBlobTokens } from "@ostra/domain";

import { bearerToken } from "../gateway/access-token.ts";
import { readBody, sendError, sendJson } from "../http.ts";
import type { BlobService } from "./blob-service.ts";

// The panel's way to store a member's file (ADR 0043: core's blob service writes every blob; ticket
// 42, a skill's files). `POST /panel/v1/blobs` with the panel's token (`panel-blob-token.ts`: an HMAC
// over the organization, the purpose, the size and the SHA-256, good for a minute). The body must be
// exactly those bytes. The blob is the organization's, with no task: a profile's skill names it, and
// the dispatch copies it into each task that uses the skill. Bytes are never logged: lines carry the
// organization, the blob's ID, the size and the digest.

export type PanelBlobEndpointDeps = {
  readonly blobs: Pick<BlobService, "put">;
  /** The secrets key's text, read when first needed: the key the panel signs with. */
  readonly secret: () => Promise<string>;
  readonly clock: Clock;
  readonly logger: Logger;
};

/** What each purpose may hold, at most: a skill's file is the profile limit's, a draft's image 10 MiB. */
const capOf = { "skill-file": profileLimits.skillFileMaxBytes, "draft-image": DRAFT_IMAGE_MAX_BYTES } as const satisfies Record<PanelBlobPurpose, number>;

export const handlePanelBlobEndpoint = (deps: PanelBlobEndpointDeps) => {
  const logger = deps.logger.child({ component: "panel-blob-endpoint" });
  let tokens: Promise<PanelBlobTokens> | undefined;
  const tokensOnce = (): Promise<PanelBlobTokens> => (tokens ??= deps.secret().then(createPanelBlobTokens));
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
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
