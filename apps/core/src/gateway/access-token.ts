import { createHmac } from "node:crypto";

import { base64urlMacEqual } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
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
      if (body === undefined || mac === undefined || rest.length > 0 || !base64urlMacEqual(sign(body), mac)) {
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

/**
 * Whether the runner an access token names may still act: its row exists in that organization and
 * isn't revoked. An access token lives 10 minutes and a revoke is at once (Q131), so every endpoint
 * that takes one reads the runner's row too: the WebSocket upgrade, the task's spec and
 * credentials, and the bulk path.
 */
export const runnerIsLive = async (
  db: Pick<Db, "runner">,
  claims: Pick<AccessClaims, "runnerId" | "organizationId">,
): Promise<boolean> => {
  const row = await db.runner.findFirst({ where: { id: claims.runnerId, organizationId: claims.organizationId }, select: { state: true, revokedAt: true } });
  return row !== null && row.state !== "revoked" && row.revokedAt === null;
};
