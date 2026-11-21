import { createHash } from "node:crypto";

import { createPanelFileTokens, PANEL_FILE_NAME_HEADER, PANEL_FILE_PATH, PANEL_FILE_TOKEN_TTL_MS, panelFileErrorSchema, recordedUploadSchema } from "@ostra/domain";
import type { PanelFileErrorCode, RecordedUpload } from "@ostra/domain";
import { parseJson, sha256HexSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, ProjectId } from "@ostra/protocol";

import type { PanelUploaderOptions } from "./panel-blobs.ts";

// A member's upload, from the panel to core (F-148, ADR 0043 amended, ADR 0070, Q338, ticket 14).
// The web app checked the member, the project, the task and the limits; this makes the file token
// (an HMAC under the secrets key over the organization, the project, the member, the size and the
// SHA-256, good for a minute) and sends the bytes to core's `POST /panel/v1/files` over core's own
// address, the name percent-encoded in its header. Core tells the kind by the bytes, stores the
// blob, reads a document's text and records the upload; it answers the file as the tray shows it,
// or a refusal's code. Logs carry IDs, sizes and codes: never the file's name, bytes or the token.

/** What an upload is for: the member's file in a project, its name as the browser gave it, and its bytes. */
export type MessageFileUploadInput = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly memberId: MemberId;
  /** The member's name for it: core makes it safe. Never logged. */
  readonly name: string;
  readonly bytes: Uint8Array;
};

/** What core made of an upload: stored (its view), refused with its code, or not reached. */
export type MessageFileUploadResult =
  | { readonly kind: "stored"; readonly file: RecordedUpload }
  | { readonly kind: "refused"; readonly code: PanelFileErrorCode; readonly message: string }
  | { readonly kind: "unavailable" };

export type MessageFileUploader = (input: MessageFileUploadInput) => Promise<MessageFileUploadResult>;

/**
 * How long core may take to answer an upload: core waits for a document's text up to about 30 s,
 * and up to 30 s more for a worker of its pool to be free, so a little over a minute and a half. A
 * working value.
 */
export const PANEL_FILE_UPLOAD_TIMEOUT_MS = 90_000;

export const corePanelFileUploader = (options: PanelUploaderOptions): MessageFileUploader => {
  const tokens = createPanelFileTokens(options.secret);
  const now = options.now ?? Date.now;
  const send = options.fetch ?? fetch;
  return async (input) => {
    const sha256 = sha256HexSchema.parse(createHash("sha256").update(input.bytes).digest("hex"));
    const token = tokens.issue({
      organizationId: input.organizationId,
      projectId: input.projectId,
      memberId: input.memberId,
      size: input.bytes.length,
      sha256,
      expiresAt: now() + PANEL_FILE_TOKEN_TTL_MS,
    });
    const logger = options.logger.child({ component: "panel-files", organizationId: input.organizationId, projectId: input.projectId, memberId: input.memberId });
    let response: Response;
    try {
      response = await send(`${options.coreUrl}${PANEL_FILE_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", [PANEL_FILE_NAME_HEADER]: encodeURIComponent(input.name) },
        body: Buffer.from(input.bytes),
        signal: AbortSignal.timeout(options.timeoutMs ?? PANEL_FILE_UPLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn("panel-file.unreachable", { size: input.bytes.length, error: error instanceof Error ? error.name : "unknown" });
      return { kind: "unavailable" };
    }
    const json = parseJson(await response.text().catch(() => ""));
    if (response.ok) {
      const stored = json.ok ? recordedUploadSchema.safeParse(json.value) : undefined;
      if (stored?.success !== true || stored.data.size !== input.bytes.length) {
        logger.warn("panel-file.answer-unread", { status: response.status, size: input.bytes.length });
        return { kind: "unavailable" };
      }
      logger.info("panel-file.stored", { fileId: stored.data.fileId, kind: stored.data.kind, size: stored.data.size, textState: stored.data.text.state });
      return { kind: "stored", file: stored.data };
    }
    const refused = json.ok ? panelFileErrorSchema.safeParse(json.value) : undefined;
    if (refused?.success !== true) {
      logger.warn("panel-file.refused", { status: response.status, size: input.bytes.length, code: null });
      return { kind: "unavailable" };
    }
    logger.info("panel-file.refused", { status: response.status, size: input.bytes.length, code: refused.data.error.code });
    return { kind: "refused", code: refused.data.error.code, message: refused.data.error.message };
  };
};
