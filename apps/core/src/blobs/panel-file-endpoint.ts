import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Logger } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import {
  createPanelFileTokens,
  PANEL_FILE_NAME_HEADER,
  PANEL_FILE_NAME_HEADER_MAX,
  PANEL_FILE_PATH,
  recordUploadWithinCapInTx,
  unsentUploadsMax,
  unsentUploadsOfInTx,
} from "@ostra/domain";
import type { Clock, FileSettings, PanelFileClaims, PanelFileError, PanelFileErrorCode, PanelFileResponse, PanelFileTokens } from "@ostra/domain";

import { storeFile, MESSAGE_FILE_PURPOSE } from "../files/store-file.ts";
import type { StoreFileDeps, StoredFile } from "../files/store-file.ts";
import { bearerToken } from "../gateway/access-token.ts";
import { readBody, sendJson } from "../http.ts";

// A member's upload (F-148, F-150, ADR 0070, Q338, ticket 10): `POST /panel/v1/files`, one file a
// request, from the web app, which checked the member, the project and the limits and computed the
// SHA-256. The body is the file's bytes; `Authorization` carries the panel's file token (ticket 05:
// an HMAC under the secrets key over the organization, the project, the member, the size and the
// SHA-256, good for a minute); `x-ostra-file-name` the member's name for it, percent-encoded.
//
// Core verifies the token, then the size and the digest against the bytes it got, and refuses
// anything else with a code (`panelFileErrorCodes`) and no content. It holds a member to twice
// `OSTRA_MESSAGE_FILES_MAX` unsent uploads in a project at once, so the tray can't fill the store.
// Then it stores the file (`storeFile`: its kind from its bytes, a blob of the project, a document's
// text read and stored beside it), writes the `MessageFile` (`uploaded`, the member's, the
// project's, no task's), and answers the file as the tray shows it. A document whose text can't be
// read is still stored and answered, with the reason. Lines carry IDs, sizes, kinds and states:
// never the file's name, bytes or text.

export type PanelFileEndpointDeps = {
  readonly db: Db;
  /** What a file is stored with: the blob service, core's text reader and `OSTRA_FILE_TEXT_EXTRACTION`. */
  readonly store: Omit<StoreFileDeps, "logger">;
  /** The message limits: one file's size, and the unsent cap made from the count. */
  readonly limits: Pick<FileSettings, "messageFilesMax" | "messageFileMaxBytes">;
  /** The secrets key's text, read when first needed: the key the panel signs with. */
  readonly secret: () => Promise<string>;
  readonly clock: Clock;
  readonly logger: Logger;
};

const statusOf = {
  unauthorized: 401,
  "size-mismatch": 400,
  "digest-mismatch": 400,
  empty: 400,
  "too-large": 413,
  "too-many-unsent": 409,
  "not-found": 404,
  "bad-request": 400,
  unavailable: 503,
} as const satisfies Record<PanelFileErrorCode, number>;

const refuse = (response: ServerResponse, code: PanelFileErrorCode, message: string): void => {
  const body: PanelFileError = { error: { code, message } };
  sendJson(response, statusOf[code], body);
};

/** The name header, decoded, or `null` when it doesn't decode. Missing is an empty name, which `safeFileName` makes `file`. */
const nameOf = (header: string | readonly string[] | undefined): string | null => {
  if (header === undefined) {
    return "";
  }
  if (typeof header !== "string") {
    return null;
  }
  try {
    return decodeURIComponent(header.slice(0, PANEL_FILE_NAME_HEADER_MAX * 3)).slice(0, PANEL_FILE_NAME_HEADER_MAX);
  } catch {
    return null;
  }
};

export const handlePanelFileEndpoint = (deps: PanelFileEndpointDeps) => {
  const logger = deps.logger.child({ component: "panel-file-endpoint" });
  const store: StoreFileDeps = { ...deps.store, logger };
  const cap = unsentUploadsMax({ maxFiles: deps.limits.messageFilesMax });
  let tokens: Promise<PanelFileTokens> | undefined;
  const tokensOnce = (): Promise<PanelFileTokens> => (tokens ??= deps.secret().then(createPanelFileTokens));

  /** Who the upload is for, as a log line names them. */
  const whoOf = (claims: PanelFileClaims) => ({ organizationId: claims.organizationId, projectId: claims.projectId, memberId: claims.memberId });

  /** Deletes what was stored for an upload that won't be recorded. */
  const dropStored = async (claims: PanelFileClaims, file: StoredFile): Promise<void> => {
    const blobIds = [file.blobId, ...(file.text.state === "ready" ? [file.text.blobId] : [])];
    for (const blobId of blobIds) {
      const deleted = await deps.store.blobs.delete(claims.organizationId, blobId);
      if (!deleted.ok && deleted.error !== "not-found") {
        // The blob stays, the project's with no file naming it; retention takes it with the project.
        logger.warn("panel-file.drop-failed", { ...whoOf(claims), blobId, error: deleted.error });
      }
    }
  };

  const take = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : (await tokensOnce()).verify(token, deps.clock.now());
    if (claims === null) {
      logger.info("panel-file.refused", { code: "unauthorized" });
      refuse(response, "unauthorized", "a valid panel file token is required");
      return;
    }
    const who = whoOf(claims);
    const refused = (code: PanelFileErrorCode, message: string, fields: Readonly<Record<string, number | string | null>> = {}): void => {
      logger.info("panel-file.refused", { ...who, size: claims.size, code, ...fields });
      refuse(response, code, message);
    };
    if (claims.size === 0) {
      refused("empty", "the file is empty");
      return;
    }
    if (claims.size > deps.limits.messageFileMaxBytes) {
      refused("too-large", "the file is over the limit for one file (OSTRA_MESSAGE_FILE_MAX_MIB)");
      return;
    }
    const name = nameOf(request.headers[PANEL_FILE_NAME_HEADER]);
    if (name === null) {
      refused("bad-request", "the file's name header doesn't decode");
      return;
    }
    const [project, member] = await Promise.all([
      deps.db.project.findFirst({ where: { id: claims.projectId, organizationId: claims.organizationId }, select: { id: true } }),
      deps.db.member.findFirst({ where: { id: claims.memberId, organizationId: claims.organizationId, state: "active" }, select: { id: true } }),
    ]);
    if (project === null || member === null) {
      refused("not-found", "no such project or member in this organization");
      return;
    }
    // Refused before the bytes are read; counted again, under a lock, when the file is recorded.
    if ((await unsentUploadsOfInTx(deps.db, claims)) >= cap) {
      refused("too-many-unsent", `you have ${String(cap)} files waiting to be sent in this project: send or remove some first`);
      return;
    }
    const body = await readBody(request, claims.size);
    if (body === "too-large") {
      refused("size-mismatch", "the body is longer than the token's size");
      return;
    }
    if (body === "timeout") {
      refused("bad-request", "the body did not arrive in time");
      return;
    }
    if (body.length !== claims.size) {
      refused("size-mismatch", "the body is not the size the token was made for", { received: body.length });
      return;
    }
    if (createHash("sha256").update(body).digest("hex") !== claims.sha256) {
      refused("digest-mismatch", "the body is not the bytes the token was made for");
      return;
    }
    const stored = await storeFile(store, { owner: { organizationId: claims.organizationId, projectId: claims.projectId, taskId: null }, purpose: MESSAGE_FILE_PURPOSE, bytes: body, name });
    if (!stored.ok) {
      refused(stored.error, stored.error === "too-large" ? "the file is over the blob cap (OSTRA_BLOB_MAX_MIB)" : "the blob store didn't answer: try again");
      return;
    }
    const { file } = stored;
    const recorded = await deps.db.$transaction((tx) => recordUploadWithinCapInTx(tx, { ...who, ...file }, cap)).catch(async (error: unknown) => {
      await dropStored(claims, file);
      throw error;
    });
    if (!recorded.ok) {
      await dropStored(claims, file);
      refused(recorded.error, recorded.message);
      return;
    }
    logger.info("panel-file.recorded", {
      ...who,
      fileId: recorded.fileId,
      blobId: file.blobId,
      kind: file.kind,
      size: file.size,
      textState: file.text.state,
      textReason: file.text.state === "failed" ? file.text.reason : null,
    });
    const answer: PanelFileResponse = { fileId: recorded.fileId, name: recorded.name, kind: recorded.kind, contentType: recorded.contentType, size: recorded.size, text: recorded.text };
    sendJson(response, 200, answer);
  };

  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    if (url.pathname !== PANEL_FILE_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      refuse(response, "not-found", "no such route");
      return true;
    }
    await take(request, response);
    return true;
  };
};
