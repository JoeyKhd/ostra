import { createHmac, timingSafeEqual } from "node:crypto";

import { organizationIdSchema, parseJson, runnerIdSchema, runnerLimits } from "@ostra/protocol";
import type { OrganizationId, RunnerId } from "@ostra/protocol";
import { z } from "zod";

// A runner's access token (ADR 0034): what `POST /runner/v1/token` returns for a signed assertion,
// sent at the WebSocket upgrade. It lives 10 minutes and names one runner of one organization. It
// is an HMAC under core's own key (kept in OSTRA_DATA_DIR), so any replica can check it without a
// table. The `ostra-runner-` prefix is one the log guard redacts. Never logged.

const PREFIX = "ostra-runner-";

const claimsSchema = z.strictObject({
  v: z.literal(1),
  r: runnerIdSchema,
  o: organizationIdSchema,
  e: z.number().int().positive(),
});

export type AccessClaims = {
  readonly runnerId: RunnerId;
  readonly organizationId: OrganizationId;
  readonly expiresAt: number;
};

export type AccessTokens = {
  readonly issue: (runnerId: RunnerId, organizationId: OrganizationId, now: number) => { readonly accessToken: string; readonly expiresAt: number };
  /** The token's claims, or `null` when it's forged, malformed or expired. */
  readonly verify: (token: string, now: number) => AccessClaims | null;
};

export const createAccessTokens = (key: Buffer, ttlMs: number = runnerLimits.accessTokenTtlMs): AccessTokens => {
  const sign = (body: string): Buffer => createHmac("sha256", key).update(body).digest();
  return {
    issue: (runnerId, organizationId, now) => {
      const expiresAt = now + ttlMs;
      const body = Buffer.from(JSON.stringify({ v: 1, r: runnerId, o: organizationId, e: expiresAt })).toString("base64url");
      return { accessToken: `${PREFIX}${body}.${sign(body).toString("base64url")}`, expiresAt };
    },
    verify: (token, now) => {
      if (!token.startsWith(PREFIX) || token.length > 4096) {
        return null;
      }
      const [body, mac, ...rest] = token.slice(PREFIX.length).split(".");
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
      if (claims?.success !== true || claims.data.e <= now) {
        return null;
      }
      return { runnerId: claims.data.r, organizationId: claims.data.o, expiresAt: claims.data.e };
    },
  };
};

/** The bearer token of an `Authorization` header, or `null`. */
export const bearerToken = (header: string | undefined): string | null => {
  if (header === undefined) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};
