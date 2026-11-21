import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { readPayloadPath, WEBHOOK_KEY_MAX, WEBHOOK_SIGNATURE_HEADER } from "./webhook-template.ts";
import type { WebhookAuth } from "./webhook-template.ts";

// A webhook automation's address, secret and verification (F-139, ADR 0056 amended 2026-11-21).
// The address's ID is random, so nobody guesses it, and it only routes: the credential is the
// secret, 32 random bytes kept in the secret store and shown once. A request proves it holds the
// secret by the HMAC-SHA256 of its raw body (`X-Ostra-Signature: sha256=<hex>`, GitHub's form), or,
// for a sender that can't sign, as a bearer token; the automation names one, and the other is
// refused. Both compare in constant time. The idempotency key is the `Idempotency-Key` header, or
// the body field the automation names, and only its SHA-256 is stored.

/** A webhook automation's address's ID: 24 random bytes, base64url. Not a credential. */
export const automationWebhookIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/, "a webhook's ID").brand<"AutomationWebhookId">();
export type AutomationWebhookId = z.infer<typeof automationWebhookIdSchema>;

export const newWebhookId = (): AutomationWebhookId => automationWebhookIdSchema.parse(randomBytes(24).toString("base64url"));

/** A secret's prefix, so a secret scanner and a person tell it apart. */
export const WEBHOOK_SECRET_PREFIX = "ostra_whsec_";

/** A new signing secret: 32 random bytes, base64url, after the prefix. */
export const newWebhookSecret = (): string => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;

/** The secret store's purpose for a webhook's secret: names it, never holds it. */
export const WEBHOOK_SECRET_PURPOSE = "automation.webhook-secret";

/** The `X-Ostra-Signature` value of a body under a secret. */
export const signWebhookBody = (secret: string, body: Uint8Array | string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** Two texts compared in constant time, whatever their lengths. */
const sameText = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export type WebhookRefusal = "missing-signature" | "bad-signature" | "missing-token" | "bad-token";

export type WebhookVerification = { readonly ok: true } | { readonly ok: false; readonly reason: WebhookRefusal };

/**
 * Whether a request holds the automation's secret, the way the automation names. Headers by their
 * lowercase names. Pure: reads nothing.
 */
export const verifyWebhookRequest = (input: {
  readonly auth: WebhookAuth;
  readonly secret: string;
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): WebhookVerification => {
  switch (input.auth) {
    case "signature": {
      const given = input.headers[WEBHOOK_SIGNATURE_HEADER]?.trim() ?? "";
      if (given === "") {
        return { ok: false, reason: "missing-signature" };
      }
      return sameText(given.toLowerCase(), signWebhookBody(input.secret, input.rawBody)) ? { ok: true } : { ok: false, reason: "bad-signature" };
    }
    case "bearer": {
      const token = /^Bearer\s+(\S+)\s*$/i.exec(input.headers["authorization"] ?? "")?.[1];
      if (token === undefined) {
        return { ok: false, reason: "missing-token" };
      }
      return sameText(token, input.secret) ? { ok: true } : { ok: false, reason: "bad-token" };
    }
    default:
      return input.auth satisfies never;
  }
};

const HAS_CONTROL = /[\u0000-\u001F\u007F]/;

export type IdempotencyKeyRead = { readonly ok: true; readonly key: string | null } | { readonly ok: false; readonly reason: "bad-idempotency-key" };

/**
 * A request's idempotency key: the `Idempotency-Key` header when it's sent, else the body field the
 * automation names (a string or a number). None is `null`: the request is taken as new. A key over
 * 255 characters or with control characters is refused.
 */
export const idempotencyKeyOf = (header: string | undefined, body: unknown, field: string | null): IdempotencyKeyRead => {
  const fromHeader = header?.trim() ?? "";
  let key: string | null = fromHeader === "" ? null : fromHeader;
  if (key === null && field !== null) {
    const value = readPayloadPath(body, field);
    const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    key = text === "" ? null : text;
  }
  if (key === null) {
    return { ok: true, key: null };
  }
  return key.length > WEBHOOK_KEY_MAX || HAS_CONTROL.test(key) ? { ok: false, reason: "bad-idempotency-key" } : { ok: true, key };
};

/** What's stored of a key: its SHA-256 in hex, never the key. */
export const hashIdempotencyKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");
