import { createHmac, timingSafeEqual } from "node:crypto";

import { blobIdSchema, organizationIdSchema, parseJson, sha256HexSchema } from "@ostra/protocol";
import type { OrganizationId, Sha256Hex } from "@ostra/protocol";
import { z } from "zod";

// What the panel hands core to store a blob for a member (ADR 0043: the panel writes no blob, core's
// blob service does; milestone 3's ticket 42, a skill's files). The panel checks the member and the
// file, then asks core with a token: an HMAC over the organization, the blob's purpose, its size and
// its SHA-256, with a deadline, under a key both processes hold (the secrets key, whose file both
// read). The token can store those bytes for that organization within a minute, and nothing else, so
// a leaked one is worth one file. It has no clock of its own: core checks the deadline it names.
// Never logged.

/** Where core takes the panel's blobs. */
export const PANEL_BLOB_PATH = "/panel/v1/blobs";

/** What the panel may store for a member: a skill's file, or a refine draft's image (ticket 27). A word, never content. */
export const PANEL_BLOB_PURPOSES = ["skill-file", "draft-image"] as const;
export type PanelBlobPurpose = (typeof PANEL_BLOB_PURPOSES)[number];

/** How long a token lives: a working value. The panel asks core the moment it has made one. */
export const PANEL_BLOB_TOKEN_TTL_MS = 60_000;

/** The prefix of the token, for the log guard's redaction. */
export const PANEL_BLOB_TOKEN_PREFIX = "ostra-panel-";

const claimsSchema = z.strictObject({
  v: z.literal(1),
  o: organizationIdSchema,
  p: z.enum(PANEL_BLOB_PURPOSES),
  s: z.number().int().min(1),
  d: sha256HexSchema,
  x: z.number().int(),
});

export type PanelBlobClaims = {
  readonly organizationId: OrganizationId;
  readonly purpose: PanelBlobPurpose;
  readonly size: number;
  readonly sha256: Sha256Hex;
  /** Epoch milliseconds: the token is no good from then on. */
  readonly expiresAt: number;
};

export type PanelBlobTokens = {
  readonly issue: (claims: PanelBlobClaims) => string;
  /** The token's claims, or `null` when it is forged, malformed or past its deadline. */
  readonly verify: (token: string, now: number) => PanelBlobClaims | null;
};

export const createPanelBlobTokens = (secret: string): PanelBlobTokens => {
  // Its own context in the MAC, so a key shared with other uses can't make a token pass for one.
  const sign = (body: string): Buffer => createHmac("sha256", secret).update(`panel-blob\n${body}`).digest();
  return {
    issue: (claims) => {
      const body = Buffer.from(JSON.stringify({ v: 1, o: claims.organizationId, p: claims.purpose, s: claims.size, d: claims.sha256, x: claims.expiresAt })).toString("base64url");
      return `${PANEL_BLOB_TOKEN_PREFIX}${body}.${sign(body).toString("base64url")}`;
    },
    verify: (token, now) => {
      if (!token.startsWith(PANEL_BLOB_TOKEN_PREFIX) || token.length > 2048) {
        return null;
      }
      const [body, mac, ...rest] = token.slice(PANEL_BLOB_TOKEN_PREFIX.length).split(".");
      if (body === undefined || mac === undefined || rest.length > 0) {
        return null;
      }
      const given = Buffer.from(mac, "base64url");
      const wanted = sign(body);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        return null;
      }
      const json = parseJson(Buffer.from(body, "base64url").toString("utf8"));
      const claims = json.ok ? claimsSchema.safeParse(json.value) : undefined;
      if (claims?.success !== true || claims.data.x <= now) {
        return null;
      }
      const { o, p, s, d, x } = claims.data;
      return { organizationId: o, purpose: p, size: s, sha256: d, expiresAt: x };
    },
  };
};

/** What core answers when it stored the panel's blob. */
export const panelBlobResponseSchema = z.strictObject({ blobId: blobIdSchema, size: z.number().int().min(1), sha256: sha256HexSchema });
export type PanelBlobResponse = z.infer<typeof panelBlobResponseSchema>;
