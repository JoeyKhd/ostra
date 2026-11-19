import { createHash } from "node:crypto";

import type { Logger } from "@ostra/adapter-sdk";
import { createPanelBlobTokens, PANEL_BLOB_PATH, PANEL_BLOB_TOKEN_TTL_MS, panelBlobResponseSchema } from "@ostra/domain";
import { organizationIdSchema, parseJson, sha256HexSchema } from "@ostra/protocol";

import type { BlobStoreView } from "./blob-store-view.ts";

// The panel's side of storing a member's file (ADR 0043: core's blob service writes every blob).
// It makes a token that lets core store these bytes for this organization within a minute, and sends
// them to core over its own address (`OSTRA_CORE_INTERNAL_URL`). Core says what it stored; the panel
// never sees another store's detail. Logs carry the organization, the size and the blob's ID.

export type PanelUploaderOptions = {
  /** Core as the panel reaches it, without a trailing slash. */
  readonly coreUrl: string;
  /** The secrets key's text: the key both processes hold. */
  readonly secret: string;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  /** How long core may take: a working value. */
  readonly timeoutMs?: number;
};

export const corePanelUploader = (options: PanelUploaderOptions): BlobStoreView["upload"] => {
  const tokens = createPanelBlobTokens(options.secret);
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  return async ({ organizationId, purpose, bytes }) => {
    const sha256 = sha256HexSchema.parse(createHash("sha256").update(bytes).digest("hex"));
    const token = tokens.issue({ organizationId: organizationIdSchema.parse(organizationId), purpose, size: bytes.length, sha256, expiresAt: now() + PANEL_BLOB_TOKEN_TTL_MS });
    const logger = options.logger.child({ component: "panel-blobs", organizationId, purpose });
    try {
      const response = await send(`${options.coreUrl}${PANEL_BLOB_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      });
      if (response.status === 413) {
        return { kind: "too-large" };
      }
      const json = parseJson(await response.text());
      const parsed = response.ok && json.ok ? panelBlobResponseSchema.safeParse(json.value) : undefined;
      if (parsed?.success !== true || parsed.data.sha256 !== sha256) {
        logger.warn("panel-blob.refused", { status: response.status, size: bytes.length });
        return { kind: "unavailable" };
      }
      logger.info("panel-blob.stored", { blobId: parsed.data.blobId, size: parsed.data.size });
      return { kind: "stored", blobId: parsed.data.blobId, size: parsed.data.size };
    } catch (error) {
      logger.warn("panel-blob.unreachable", { error: error instanceof Error ? error.name : "unknown" });
      return { kind: "unavailable" };
    }
  };
};
