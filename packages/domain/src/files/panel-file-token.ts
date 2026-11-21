import { createHmac } from "node:crypto";

import { base64urlMacEqual } from "@ostra/adapter-sdk";
import { memberIdSchema, organizationIdSchema, parseJson, projectIdSchema, runnerLimits, sha256HexSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, ProjectId, Sha256Hex } from "@ostra/protocol";
import { z } from "zod";

import { PANEL_BLOB_TOKEN_PREFIX } from "../panel-blob-token.ts";

// A member's upload goes through the web app to core (ADR 0043 amended, ADR 0070, Q338): the web
// app checks the member can open the project, the file's size against the limit and the member's
// unsent count, computes its SHA-256, and sends the bytes to core's `POST /panel/v1/files` with this
// token: an HMAC under the secrets key over the organization, the project, the member, the size and
// the SHA-256, good for a minute. It stores those bytes as that member's upload in that project and
// nothing else, so a leaked one is worth one file. It has no clock of its own: core checks the
// deadline it names. Its prefix is under the one the log guard redacts (`ostra-panel-`). Never logged.

/** Where core takes a member's upload. */
export const PANEL_FILE_PATH = "/panel/v1/files";

/** The token's prefix: under the one the log guard redacts (`PANEL_BLOB_TOKEN_PREFIX`). */
export const PANEL_FILE_TOKEN_PREFIX = `${PANEL_BLOB_TOKEN_PREFIX}file-`;

/** How long a token lives: the web app asks core the moment it has made one. */
export const PANEL_FILE_TOKEN_TTL_MS = 60_000;

const claimsSchema = z.strictObject({
  v: z.literal(1),
  o: organizationIdSchema,
  p: projectIdSchema,
  m: memberIdSchema,
  s: z.number().int().min(0).max(runnerLimits.messageFileMaxBytes),
  d: sha256HexSchema,
  x: z.number().int(),
});

export type PanelFileClaims = {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  /** The member the upload is for: only they can send or discard it. */
  readonly memberId: MemberId;
  readonly size: number;
  readonly sha256: Sha256Hex;
  /** Epoch milliseconds: the token is no good from then on. */
  readonly expiresAt: number;
};

export type PanelFileTokens = {
  readonly issue: (claims: PanelFileClaims) => string;
  /** The token's claims, or `null` when it's forged, malformed, past its deadline or longer-lived than the web app makes one. */
  readonly verify: (token: string, now: number) => PanelFileClaims | null;
};

export const createPanelFileTokens = (secret: string): PanelFileTokens => {
  // Its own context in the MAC, so a blob token or another panel token under the same key can't pass for one.
  const sign = (body: string): Buffer => createHmac("sha256", secret).update(`panel-file\n${body}`).digest();
  return {
    issue: (claims) => {
      const body = Buffer.from(
        JSON.stringify({ v: 1, o: claims.organizationId, p: claims.projectId, m: claims.memberId, s: claims.size, d: claims.sha256, x: claims.expiresAt }),
      ).toString("base64url");
      return `${PANEL_FILE_TOKEN_PREFIX}${body}.${sign(body).toString("base64url")}`;
    },
    verify: (token, now) => {
      if (!token.startsWith(PANEL_FILE_TOKEN_PREFIX) || token.length > 2048) {
        return null;
      }
      const [body, mac, ...rest] = token.slice(PANEL_FILE_TOKEN_PREFIX.length).split(".");
      if (body === undefined || mac === undefined || rest.length > 0 || !base64urlMacEqual(sign(body), mac)) {
        return null;
      }
      const json = parseJson(Buffer.from(body, "base64url").toString("utf8"));
      const claims = json.ok ? claimsSchema.safeParse(json.value) : undefined;
      if (claims?.success !== true || claims.data.x <= now || claims.data.x - now > PANEL_FILE_TOKEN_TTL_MS) {
        return null;
      }
      const { o, p, m, s, d, x } = claims.data;
      return { organizationId: o, projectId: p, memberId: m, size: s, sha256: d, expiresAt: x };
    },
  };
};
