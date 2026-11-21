import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { base64urlMacEqual } from "@ostra/adapter-sdk";
import {
  cliTunnelTicketSchema,
  loginSessionIdSchema,
  memberIdSchema,
  organizationIdSchema,
  parseJson,
  previewKeySchema,
  previewLinkIdSchema,
  previewViewIdSchema,
  taskIdSchema,
} from "@ostra/protocol";
import type { LoginSessionId, MemberId, OrganizationId, PreviewKey, PreviewLinkId, PreviewViewId, Sha256Hex, TaskId } from "@ostra/protocol";
import { z } from "zod";

import { PREVIEW_COOKIE_MAX_MS } from "./host.ts";

// The previews' secrets (milestone 8, F-142, F-143, F-144, ADR 0068): a link's token, the native
// preview's one-time code and the CLI's tunnel ticket, the panel's token for one view, the native
// preview's cookie, and the signature one replica puts on a request it forwards to another. Each is a bearer secret: it's
// kept only as its SHA-256 (or checked by its MAC), compared in constant time, and never logged:
// each has a prefix the logger redacts (`@ostra/adapter-sdk`'s `redactTokens`).

/** Random bytes: Node's by default, a fixed source in tests. */
export type RandomBytes = (size: number) => Uint8Array;

const sha256Hex = (text: string): Sha256Hex => createHash("sha256").update(text, "utf8").digest("hex");

/** Whether two SHA-256 hex digests are equal, in constant time. */
const sameDigest = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
};

const randomPart = (random: RandomBytes): string => Buffer.from(random(32)).toString("base64url");

// ---------- a link's token (F-142) ----------

/** A link's token's prefix, which the logger redacts. */
export const PREVIEW_LINK_TOKEN_PREFIX = "ostra-preview-";

/** A link's token: `ostra-preview-` and 32 random bytes in base64url. Shown once; never stored or logged. */
export const previewLinkTokenSchema = z
  .string()
  .regex(/^ostra-preview-[A-Za-z0-9_-]{43}$/, "an ostra preview link")
  .describe("A preview link's token. Never logged; stored only as its SHA-256.");

/** A new link's token, and the hash its row keeps. */
export const newPreviewLinkToken = (random: RandomBytes = randomBytes): { readonly token: string; readonly tokenHash: Sha256Hex } => {
  const token = `${PREVIEW_LINK_TOKEN_PREFIX}${randomPart(random)}`;
  return { token, tokenHash: sha256Hex(token) };
};

/** The hash a presented token is looked up by, or `null` for text that isn't a link's token. */
export const previewLinkTokenHash = (token: string): Sha256Hex | null => (previewLinkTokenSchema.safeParse(token).success ? sha256Hex(token) : null);

/** Whether a presented token is the one a row's hash was made from, compared in constant time. */
export const previewLinkTokenMatches = (token: string, tokenHash: string): boolean => {
  const presented = previewLinkTokenHash(token);
  return presented !== null && sameDigest(presented, tokenHash);
};

// ---------- the one-time code and the CLI's ticket (F-143, F-144) ----------

/** How long a code or a ticket lives *(working value)*. */
export const PREVIEW_CODE_TTL_MS = 60_000;

/** A one-time code's prefix, which the logger redacts. A CLI ticket's is the protocol's `ostra_pt_`. */
export const PREVIEW_CODE_PREFIX = "ostra-code-";

/** A native preview's one-time code. Never logged. */
export const previewCodeSchema = z.string().regex(/^ostra-code-[A-Za-z0-9_-]{43}$/, "an ostra preview code").describe("A one-time code. Never logged.");

/** Who a code or a ticket is for: a member, or a link (a code only; a CLI ticket is a member's). */
export type PreviewCodeViewer = { readonly kind: "member"; readonly memberId: MemberId } | { readonly kind: "link"; readonly linkId: PreviewLinkId };

/** What a code or a ticket is bound to (ADR 0068): its kind, the task, the preview's port, the viewer and the lease epoch. */
export type PreviewCodeBinding = {
  readonly kind: "enter" | "cli_ticket";
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly port: number;
  readonly leaseEpoch: number;
  readonly viewer: PreviewCodeViewer;
};

/** A code's row (`PreviewCode`): its hash and its binding, never the code. */
export type PreviewCodeRow = {
  readonly kind: "enter" | "cli_ticket";
  readonly codeHash: Sha256Hex;
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly port: number;
  readonly memberId: MemberId | null;
  readonly linkId: PreviewLinkId | null;
  readonly leaseEpoch: number;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
};

export type IssuedPreviewCode =
  | { readonly ok: true; readonly code: string; readonly row: PreviewCodeRow }
  /** A CLI ticket is for a member only, never a link (ADR 0068, "`ostra preview`"). */
  | { readonly ok: false; readonly reason: "ticket-for-a-link" };

/** A new code or ticket, and the row that keeps its hash, its binding and its deadline. */
export const issuePreviewCode = (binding: PreviewCodeBinding, now: number, random: RandomBytes = randomBytes): IssuedPreviewCode => {
  if (binding.kind === "cli_ticket" && binding.viewer.kind !== "member") {
    return { ok: false, reason: "ticket-for-a-link" };
  }
  const code = binding.kind === "enter" ? `${PREVIEW_CODE_PREFIX}${randomPart(random)}` : `ostra_pt_${randomPart(random)}`;
  return {
    ok: true,
    code,
    row: {
      kind: binding.kind,
      codeHash: sha256Hex(code),
      taskId: binding.taskId,
      key: binding.key,
      port: binding.port,
      memberId: binding.viewer.kind === "member" ? binding.viewer.memberId : null,
      linkId: binding.viewer.kind === "link" ? binding.viewer.linkId : null,
      leaseEpoch: binding.leaseEpoch,
      expiresAt: new Date(now + PREVIEW_CODE_TTL_MS),
      usedAt: null,
    },
  };
};

/** The hash a presented code or ticket is looked up by, or `null` for text that isn't one. */
export const previewCodeHash = (code: string): Sha256Hex | null =>
  previewCodeSchema.safeParse(code).success || cliTunnelTicketSchema.safeParse(code).success ? sha256Hex(code) : null;

/** What the redeemer knows: the kind it takes, the task's current lease epoch, and where the request came, when it says. */
export type PreviewCodeExpected = {
  readonly kind: "enter" | "cli_ticket";
  readonly leaseEpoch: number;
  readonly now: number;
  /** The task and port a preview host names, for a handshake; a CLI ticket names them itself. */
  readonly taskId?: TaskId;
  readonly port?: number;
};

export type PreviewCodeCheck =
  | { readonly ok: true; readonly viewer: PreviewCodeViewer; readonly taskId: TaskId; readonly key: PreviewKey; readonly port: number }
  | { readonly ok: false; readonly reason: "unknown" | "used" | "expired" | "wrong-kind" | "wrong-binding" | "stale-lease" };

/**
 * Whether a presented code redeems `row` (ADR 0068): it's the row's (by its hash, in constant
 * time), unused, under 60 s old, of the kind asked, for the same task, port and lease epoch. The
 * caller marks it used in the same statement it reads it (`usedAt IS NULL`), so it works once.
 */
export const checkPreviewCode = (code: string, row: PreviewCodeRow | null, expected: PreviewCodeExpected): PreviewCodeCheck => {
  const presented = previewCodeHash(code);
  if (row === null || presented === null || !sameDigest(presented, row.codeHash)) {
    return { ok: false, reason: "unknown" };
  }
  if (row.usedAt !== null) {
    return { ok: false, reason: "used" };
  }
  if (row.expiresAt.getTime() <= expected.now) {
    return { ok: false, reason: "expired" };
  }
  if (row.kind !== expected.kind) {
    return { ok: false, reason: "wrong-kind" };
  }
  if ((expected.taskId !== undefined && expected.taskId !== row.taskId) || (expected.port !== undefined && expected.port !== row.port)) {
    return { ok: false, reason: "wrong-binding" };
  }
  if (row.leaseEpoch !== expected.leaseEpoch) {
    return { ok: false, reason: "stale-lease" };
  }
  const viewer: PreviewCodeViewer | null =
    row.memberId !== null ? { kind: "member", memberId: row.memberId } : row.linkId !== null ? { kind: "link", linkId: row.linkId } : null;
  if (viewer === null || (row.kind === "cli_ticket" && viewer.kind !== "member")) {
    return { ok: false, reason: "wrong-binding" };
  }
  return { ok: true, viewer, taskId: row.taskId, key: row.key, port: row.port };
};

// ---------- the panel's token for one view (F-141) ----------

/** The panel's preview token's prefix, which the logger redacts. */
export const PANEL_PREVIEW_TOKEN_PREFIX = "ostra-view-";

/** How long a panel preview token lives: a minute, to reach core and open the stream. */
export const PANEL_PREVIEW_TOKEN_TTL_MS = 60_000;

const viewClaimsSchema = z.strictObject({
  v: z.literal(1),
  o: organizationIdSchema,
  w: previewViewIdSchema,
  m: memberIdSchema.nullable(),
  l: previewLinkIdSchema.nullable(),
  x: z.number().int(),
});

/** What the panel asks core for on a viewer's behalf: one view, for one member or one link, for a minute. */
export type PanelPreviewClaims = {
  readonly organizationId: OrganizationId;
  readonly viewId: PreviewViewId;
  readonly viewer: PreviewCodeViewer;
  /** Epoch ms: no good from then on. */
  readonly expiresAt: number;
};

export type PanelPreviewTokens = {
  readonly issue: (claims: PanelPreviewClaims) => string;
  /** The token's claims, or `null` when it's forged, malformed, past its deadline or for another view. */
  readonly verify: (token: string, now: number, viewId: PreviewViewId) => PanelPreviewClaims | null;
};

/**
 * The panel's token to core for a view's stream and input (ADR 0068, modelled on
 * `panel-blob-token.ts`): an HMAC under the secrets key over the organization, the view, the
 * member or the link, and a deadline a minute ahead. Never logged.
 */
export const createPanelPreviewTokens = (secret: string): PanelPreviewTokens => {
  const sign = (body: string): Buffer => createHmac("sha256", secret).update(`panel-preview\n${body}`).digest();
  return {
    issue: (claims) => {
      const body = Buffer.from(
        JSON.stringify({
          v: 1,
          o: claims.organizationId,
          w: claims.viewId,
          m: claims.viewer.kind === "member" ? claims.viewer.memberId : null,
          l: claims.viewer.kind === "link" ? claims.viewer.linkId : null,
          x: claims.expiresAt,
        }),
      ).toString("base64url");
      return `${PANEL_PREVIEW_TOKEN_PREFIX}${body}.${sign(body).toString("base64url")}`;
    },
    verify: (token, now, viewId) => {
      if (!token.startsWith(PANEL_PREVIEW_TOKEN_PREFIX) || token.length > 2048) {
        return null;
      }
      const [body, mac, ...rest] = token.slice(PANEL_PREVIEW_TOKEN_PREFIX.length).split(".");
      if (body === undefined || mac === undefined || rest.length > 0 || !base64urlMacEqual(sign(body), mac)) {
        return null;
      }
      const json = parseJson(Buffer.from(body, "base64url").toString("utf8"));
      const claims = json.ok ? viewClaimsSchema.safeParse(json.value) : undefined;
      if (claims?.success !== true || claims.data.x <= now || claims.data.x - now > PANEL_PREVIEW_TOKEN_TTL_MS || claims.data.w !== viewId) {
        return null;
      }
      const { o, w, m, l, x } = claims.data;
      const viewer: PreviewCodeViewer | null = m !== null && l === null ? { kind: "member", memberId: m } : l !== null && m === null ? { kind: "link", linkId: l } : null;
      return viewer === null ? null : { organizationId: o, viewId: w, viewer, expiresAt: x };
    },
  };
};

// ---------- the native preview's cookie (F-144) ----------

/** A preview cookie's value's prefix, which the logger redacts (`ostra-preview-…`). */
export const PREVIEW_COOKIE_TOKEN_PREFIX = "ostra-preview-cookie-";

/** Who a preview cookie is for: a member in one panel login session, or a link. */
export type PreviewCookieViewer =
  | { readonly kind: "member"; readonly memberId: MemberId; readonly loginSessionId: LoginSessionId }
  | { readonly kind: "link"; readonly linkId: PreviewLinkId };

/** What the handshake's cookie carries (ADR 0068): the preview it opens, its viewer, and its deadline. Never logged. */
export type PreviewCookieClaims = {
  /** A random ID of this handshake's grant: what a replica keys what it checked by. Not a secret. */
  readonly grantId: string;
  readonly organizationId: OrganizationId;
  readonly taskId: TaskId;
  readonly key: PreviewKey;
  readonly port: number;
  readonly viewer: PreviewCookieViewer;
  /** Epoch ms: no good from then on. */
  readonly expiresAt: number;
};

const cookieClaimsSchema = z.strictObject({
  v: z.literal(1),
  g: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  o: organizationIdSchema,
  t: taskIdSchema,
  k: previewKeySchema,
  p: z.number().int().min(1024).max(65_535),
  m: memberIdSchema.nullable(),
  s: loginSessionIdSchema.nullable(),
  l: previewLinkIdSchema.nullable(),
  x: z.number().int(),
});

export type PreviewCookies = {
  /** A new grant's claims' cookie value, under the secrets key. */
  readonly issue: (claims: PreviewCookieClaims) => string;
  /** The claims, or `null` when the value is forged, malformed or past its deadline (or more than 12 hours ahead). */
  readonly verify: (value: string, now: number) => PreviewCookieClaims | null;
  /** A new grant's random ID. */
  readonly newGrantId: () => string;
};

/**
 * The native preview's cookie (ADR 0068, "The handshake"): an HMAC under the secrets key every
 * replica shares, over the organization, the task, the preview's key and port, the member and the
 * panel login session (or the link), and a deadline at most 12 hours ahead. Stateless, so any
 * replica reads it; core still checks the viewer and the lease against the rows on each new
 * connection and every 5 minutes, so a removed member, a revoked link or a signed-out session ends
 * it before its deadline. Never logged.
 */
export const createPreviewCookies = (secret: string, random: RandomBytes = randomBytes): PreviewCookies => {
  const sign = (body: string): Buffer => createHmac("sha256", secret).update(`preview-cookie\n${body}`).digest();
  return {
    issue: (claims) => {
      const body = Buffer.from(
        JSON.stringify({
          v: 1,
          g: claims.grantId,
          o: claims.organizationId,
          t: claims.taskId,
          k: claims.key,
          p: claims.port,
          m: claims.viewer.kind === "member" ? claims.viewer.memberId : null,
          s: claims.viewer.kind === "member" ? claims.viewer.loginSessionId : null,
          l: claims.viewer.kind === "link" ? claims.viewer.linkId : null,
          x: claims.expiresAt,
        }),
      ).toString("base64url");
      return `${PREVIEW_COOKIE_TOKEN_PREFIX}${body}.${sign(body).toString("base64url")}`;
    },
    verify: (value, now) => {
      if (!value.startsWith(PREVIEW_COOKIE_TOKEN_PREFIX) || value.length > 2048) {
        return null;
      }
      const [body, mac, ...rest] = value.slice(PREVIEW_COOKIE_TOKEN_PREFIX.length).split(".");
      if (body === undefined || mac === undefined || rest.length > 0 || !base64urlMacEqual(sign(body), mac)) {
        return null;
      }
      const json = parseJson(Buffer.from(body, "base64url").toString("utf8"));
      const claims = json.ok ? cookieClaimsSchema.safeParse(json.value) : undefined;
      if (claims?.success !== true || claims.data.x <= now || claims.data.x - now > PREVIEW_COOKIE_MAX_MS + 60_000) {
        return null;
      }
      const { g, o, t, k, p, m, s, l, x } = claims.data;
      const viewer: PreviewCookieViewer | null =
        m !== null && s !== null && l === null ? { kind: "member", memberId: m, loginSessionId: s } : l !== null && m === null && s === null ? { kind: "link", linkId: l } : null;
      return viewer === null ? null : { grantId: g, organizationId: o, taskId: t, key: k, port: p, viewer, expiresAt: x };
    },
    newGrantId: () => Buffer.from(random(16)).toString("base64url"),
  };
};

// ---------- a forwarded request between replicas (F-141, Q305) ----------

/** The header a forwarded request carries its signature in. */
export const REPLICA_SIGNATURE_HEADER = "x-ostra-replica-signature";

/** How old a forwarded request's signature may be, either way *(working value)*. */
export const REPLICA_SIGNATURE_MAX_AGE_MS = 30_000;

/** What a replica signs when it forwards a view's request to the replica that holds the box's connection. */
export type ReplicaRequest = {
  readonly method: string;
  /** The request's path and query, as sent. */
  readonly path: string;
  readonly viewId: PreviewViewId;
  /** Epoch ms when the forwarding replica signed it. */
  readonly at: number;
};

const replicaMac = (secret: string, request: ReplicaRequest): Buffer =>
  createHmac("sha256", secret).update(`replica-forward\n${request.method.toUpperCase()}\n${request.path}\n${request.viewId}\n${String(request.at)}`).digest();

/** The signature's value: the time and the MAC under the secrets key every replica shares. */
export const signReplicaRequest = (secret: string, request: ReplicaRequest): string => `${String(request.at)}.${replicaMac(secret, request).toString("base64url")}`;

/**
 * Whether a forwarded request's signature is good at `now`: made under the shared key over this
 * method, path and view, within 30 s either way. A replica refuses a request it can't verify.
 */
export const verifyReplicaRequest = (
  secret: string,
  request: Omit<ReplicaRequest, "at">,
  signature: string,
  now: number,
): boolean => {
  const found = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(signature);
  if (found === null) {
    return false;
  }
  const at = Number(found[1]);
  if (Math.abs(now - at) > REPLICA_SIGNATURE_MAX_AGE_MS) {
    return false;
  }
  return base64urlMacEqual(replicaMac(secret, { ...request, at }), found[2] ?? "");
};
