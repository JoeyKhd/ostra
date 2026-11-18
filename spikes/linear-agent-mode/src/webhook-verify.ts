import { setTimeout as delay } from "node:timers/promises";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import { DeliveryId } from "./ids.ts";

export type VerifyFailure = "missing-signature" | "bad-signature" | "bad-timestamp" | "malformed-body";

export type VerifyOutcome =
  | { readonly ok: true; readonly signature: string; readonly delivery: DeliveryId | null; readonly body: unknown }
  | { readonly ok: false; readonly reason: VerifyFailure };

export type WebhookVerifier = (
  rawBody: Buffer,
  headers: { readonly signature: string | undefined; readonly delivery: string | undefined },
) => VerifyOutcome;

/**
 * Signature and freshness come from the SDK's LinearWebhookClient: a constant-time HMAC-SHA256 over the raw
 * body, then the signed body's `webhookTimestamp` against a 60 s window. The parsed body leaves here as
 * `unknown`: it is validated with Zod by the caller, not trusted because it was signed.
 */
export const createWebhookVerifier = (secret: string): WebhookVerifier => {
  const client = new LinearWebhookClient(secret);
  return (rawBody, headers) => {
    if (headers.signature === undefined || headers.signature.length === 0) {
      return { ok: false, reason: "missing-signature" };
    }
    try {
      client.verify(rawBody, headers.signature);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return { ok: false, reason: "malformed-body" };
      const message = error instanceof Error ? error.message : "";
      return { ok: false, reason: /timestamp/i.test(message) ? "bad-timestamp" : "bad-signature" };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed-body" };
    }
    const delivery = DeliveryId.safeParse(headers.delivery);
    return { ok: true, signature: headers.signature, delivery: delivery.success ? delivery.data : null, body };
  };
};

export type DeliveryLedger = {
  /**
   * True the first time a key is seen inside the window, false for a repeat. Async because in ostra this is a
   * Postgres insert: the 200 waits for it, so its latency is part of the 5 s.
   */
  claim: (key: string) => Promise<boolean>;
  size: () => number;
};

export type DeliveryLedgerOptions = {
  readonly windowMs: number;
  readonly now: () => number;
  /**
   * Real milliseconds every claim takes before it answers: the durable insert, and the network to the database.
   * A fault knob for the latency scenarios. Zero (the default) means the Map alone, which is not what ostra has.
   */
  readonly insertDelayMs?: number;
  /** Aborts a claim that is waiting (the server is closing). The claim then rejects with an AbortError. */
  readonly signal?: AbortSignal;
};

/**
 * In the spike this is a Map. In ostra it is the durable inbox table (research/integrations-platform.md):
 * insert, then answer 200. Both the delivery ID and the signature are keys: a retry repeats the first,
 * and a replayed capture repeats the second (the SDK says to skip signatures it has already seen).
 */
export const createDeliveryLedger = (options: DeliveryLedgerOptions): DeliveryLedger => {
  const seen = new Map<string, number>();
  const insertDelayMs = options.insertDelayMs ?? 0;
  const sweep = (): void => {
    const cutoff = options.now() - options.windowMs;
    for (const [key, at] of seen) {
      if (at < cutoff) seen.delete(key);
    }
  };
  return {
    claim: async (key) => {
      if (insertDelayMs > 0) await delay(insertDelayMs, undefined, options.signal === undefined ? {} : { signal: options.signal });
      sweep();
      if (seen.has(key)) return false;
      seen.set(key, options.now());
      return true;
    },
    size: () => seen.size,
  };
};
