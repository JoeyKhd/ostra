import { createHash } from "node:crypto";

import { adapterError, NotificationAdapter, ok, parseRetryAfter, parseVendor } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  HealthReport,
  Notification,
  NotificationCapabilities,
  NotificationRecipient,
  RefusedRecipient,
  SendResult,
} from "@ostra/adapter-sdk";
import { Resend } from "resend";
import { z } from "zod";

// The Resend email adapter (ADR 0007, ADR 0050, F-115): Resend is the first email option. It sends
// the notification's rendered subject, HTML and text from the configured address, one message per
// recipient, so one bounce never hides another, and each with Resend's idempotency key made from
// the notification's key and the recipient, so a retried delivery mails nobody twice (Resend keeps
// a key for 24 hours).
//
// The API key comes in the constructor, from the secret store through core: the adapter never reads
// the environment, and neither the key, an address nor a mail's words ever reach a log line or an
// error message. Errors are in words: a recipient Resend refuses is that recipient's failure
// (`refused`), and everything else (the key, the sender's domain, the rate limit, an outage) is the
// adapter's.

export type ResendEmailAdapterOptions = {
  /** Resend's API key, from the secret store. Never logged. */
  readonly apiKey: string;
  /** The address mail comes from, on a domain verified in Resend (or `onboarding@resend.dev`). */
  readonly from: string;
  /** The name mail comes from. Default `ostra`. */
  readonly fromName?: string;
  /** Resend's API address. Default Resend's own; a test points it at the fake. */
  readonly baseUrl?: string;
  /** How long one call may take, in ms. Default 15,000. */
  readonly timeoutMs?: number;
};

const DEFAULT_BASE_URL = "https://api.resend.com";
const USER_AGENT = "ostra";
const DEFAULT_FROM_NAME = "ostra";
const DEFAULT_TIMEOUT_MS = 15_000;
/** Resend's longest idempotency key. */
const MAX_IDEMPOTENCY_KEY = 256;
/** What a 429 waits when Resend sends no `Retry-After`: the per-second limit, then the daily quota. */
const DEFAULT_RETRY_MS = 1000;
const QUOTA_RETRY_MS = 60 * 60 * 1000;
/** Resend's shared test sender: it needs no verified domain. */
const TEST_DOMAIN = "resend.dev";

const sentSchema = z.looseObject({ id: z.string().min(1) });
const domainsSchema = z.looseObject({
  data: z.array(z.looseObject({ name: z.string(), status: z.string() })),
});

/** The display name of the sender, made safe for an address header: no quotes, angle brackets, commas or line breaks. */
const cleanName = (name: string): string => name.replaceAll(/["<>,\r\n]+/g, " ").replaceAll(/\s+/g, " ").trim();

const ADDRESS = /^[^\s@<>,]+@([^\s@<>,]+\.[^\s@<>,]+)$/;

/** The domain of a plain address, or `undefined` when it isn't one. */
const domainOf = (address: string): string | undefined => ADDRESS.exec(address.trim())?.[1]?.toLowerCase();

/** The idempotency key for one recipient: the notification's key and the member, hashed when too long for Resend. */
export const resendIdempotencyKey = (notificationKey: string, memberId: string): string => {
  const raw = `${notificationKey}:${memberId}`;
  return raw.length <= MAX_IDEMPOTENCY_KEY ? raw : `sha256:${createHash("sha256").update(raw).digest("hex")}`;
};

/** What Resend's error said, reduced to what ostra acts on. */
type ResendFailure = {
  readonly name: string;
  readonly statusCode: number | null;
  readonly headers: Readonly<Record<string, string>> | null;
};

/** One recipient's outcome: sent (Resend's ID), refused (theirs alone) or a failure of the adapter's. */
type RecipientOutcome =
  | { readonly kind: "sent"; readonly id: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: AdapterError };

export class ResendEmailAdapter extends NotificationAdapter {
  readonly name = "resend";
  readonly capabilities: NotificationCapabilities = { channels: ["email"], edits: false };

  readonly #client: Resend;
  readonly #from: string;
  readonly #fromDomain: string | undefined;
  readonly #timeoutMs: number;

  constructor(options: ResendEmailAdapterOptions, context?: AdapterContext) {
    super(context);
    // Without a key `Resend` would read the environment: this adapter never does.
    // Everything is explicit: left to itself, the client reads `RESEND_API_KEY`, `RESEND_BASE_URL` and `RESEND_USER_AGENT`.
    this.#client = new Resend(options.apiKey === "" ? "missing" : options.apiKey, { baseUrl: options.baseUrl ?? DEFAULT_BASE_URL, userAgent: USER_AGENT });
    this.#from = `${cleanName(options.fromName ?? DEFAULT_FROM_NAME) || DEFAULT_FROM_NAME} <${options.from.trim()}>`;
    this.#fromDomain = domainOf(options.from);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async health(): Promise<HealthReport> {
    if (this.#fromDomain === undefined) {
      return { status: "down", reason: "the from address isn't an email address" };
    }
    const listed = await this.#client.domains.list(undefined, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (listed.error !== null) {
      const failure = { name: listed.error.name, statusCode: listed.error.statusCode, headers: listed.headers };
      return this.#healthOf(failure);
    }
    const parsed = parseVendor(domainsSchema, listed.data, "Resend's domain list");
    if (!parsed.ok) {
      return { status: "down", reason: "Resend answered something ostra can't read" };
    }
    if (this.#fromDomain === TEST_DOMAIN) {
      return { status: "ok" };
    }
    const domain = parsed.value.data.find((candidate) => candidate.name.toLowerCase() === this.#fromDomain);
    if (domain === undefined) {
      return { status: "down", reason: `the domain ${this.#fromDomain} isn't set up in Resend, so it won't send from it` };
    }
    if (domain.status !== "verified") {
      return { status: "down", reason: `the domain ${this.#fromDomain} isn't verified in Resend yet (it is ${domain.status.replaceAll("_", " ")})` };
    }
    return { status: "ok" };
  }

  async send(notification: Notification): Promise<AdapterResult<SendResult>> {
    const rendered = notification.rendered;
    if (rendered === null) {
      return adapterError("invalid-input", "an email needs its rendered subject, HTML and text");
    }
    if (this.#fromDomain === undefined) {
      return adapterError("invalid-input", "the from address isn't an email address");
    }
    const refused: RefusedRecipient[] = [];
    const sendable: { readonly recipient: NotificationRecipient; readonly address: string }[] = [];
    const seen = new Set<string>();
    for (const recipient of notification.recipients) {
      const address = recipient.email?.trim() ?? "";
      if (address === "") {
        refused.push({ memberId: recipient.memberId, reason: "the member has no email address" });
      } else if (domainOf(address) === undefined) {
        refused.push({ memberId: recipient.memberId, reason: "the member's email address isn't valid" });
      } else if (!seen.has(address.toLowerCase())) {
        seen.add(address.toLowerCase());
        sendable.push({ recipient, address });
      }
    }
    // One at a time: Resend's limit is per second, and a failure then names the recipient it stopped at.
    let providerMessageId: string | null = null;
    for (const { recipient, address } of sendable) {
      const outcome = await this.#sendOne(notification, rendered, recipient, address);
      switch (outcome.kind) {
        case "sent":
          providerMessageId ??= outcome.id;
          break;
        case "refused":
          refused.push({ memberId: recipient.memberId, reason: outcome.reason });
          break;
        case "failed":
          this.plumbing.logger.warn("resend.send_failed", { kind: notification.kind, code: outcome.error.code, sent: providerMessageId === null ? 0 : 1 });
          // Anyone mailed already is safe: the retry sends the same keys, and Resend answers them without mailing again.
          return { ok: false, error: outcome.error };
        default:
          return outcome satisfies never;
      }
    }
    this.plumbing.logger.info("resend.sent", { kind: notification.kind, recipients: sendable.length, refused: refused.length });
    return ok({ providerMessageId, refused });
  }

  async #sendOne(
    notification: Notification,
    rendered: { readonly subject: string; readonly html: string; readonly text: string },
    recipient: NotificationRecipient,
    address: string,
  ): Promise<RecipientOutcome> {
    const response = await this.#client.emails.send(
      { from: this.#from, to: [address], subject: rendered.subject, html: rendered.html, text: rendered.text },
      { idempotencyKey: resendIdempotencyKey(notification.idempotencyKey, recipient.memberId), signal: AbortSignal.timeout(this.#timeoutMs) },
    );
    if (response.error !== null) {
      return this.#failure({ name: response.error.name, statusCode: response.error.statusCode, headers: response.headers });
    }
    const parsed = parseVendor(sentSchema, response.data, "Resend's send answer");
    return parsed.ok ? { kind: "sent", id: parsed.value.id } : { kind: "failed", error: parsed.error };
  }

  /** Sorts a failed send: the recipient's own, or the adapter's. */
  #failure(failure: ResendFailure): RecipientOutcome {
    const status = failure.statusCode;
    const retryAfter = parseRetryAfter(failure.headers?.["retry-after"], this.plumbing.clock.now());
    switch (failure.name) {
      case "rate_limit_exceeded":
        return { kind: "failed", error: adapterError("rate-limited", "Resend's rate limit", retryAfter ?? DEFAULT_RETRY_MS).error };
      case "daily_quota_exceeded":
      case "monthly_quota_exceeded":
        return { kind: "failed", error: adapterError("rate-limited", "Resend's sending quota is used up", retryAfter ?? QUOTA_RETRY_MS).error };
      case "missing_api_key":
      case "invalid_api_key":
        return { kind: "failed", error: adapterError("unauthorized", "Resend refused the API key").error };
      case "restricted_api_key":
      case "invalid_access":
        return { kind: "failed", error: adapterError("forbidden", "the Resend API key isn't allowed to send").error };
      case "invalid_from_address":
        return { kind: "failed", error: adapterError("invalid-input", "Resend refused the from address").error };
      case "invalid_idempotent_request":
      case "concurrent_idempotent_requests":
        return { kind: "failed", error: adapterError("conflict", "Resend saw this send's key used for another mail, or still in flight").error };
      case "invalid_idempotency_key":
        return { kind: "failed", error: adapterError("invalid-input", "Resend refused the idempotency key").error };
      default:
        break;
    }
    if (status === 429) {
      return { kind: "failed", error: adapterError("rate-limited", "Resend's rate limit", retryAfter ?? DEFAULT_RETRY_MS).error };
    }
    if (status === 401) {
      return { kind: "failed", error: adapterError("unauthorized", "Resend refused the API key").error };
    }
    if (status === 403) {
      // Resend answers an unverified sender domain with 403: the adapter's trouble, not a recipient's.
      return { kind: "failed", error: adapterError("forbidden", "Resend won't send from this address: its domain isn't verified").error };
    }
    if (status === 422 || (status === 400 && failure.name === "validation_error")) {
      // The only field a send varies per recipient is the address.
      return { kind: "refused", reason: "Resend refused the member's email address" };
    }
    if (status === null || status >= 500) {
      return { kind: "failed", error: adapterError("unavailable", "Resend couldn't be reached or failed").error };
    }
    return { kind: "failed", error: adapterError("invalid-response", `Resend answered ${String(status)} to a send`).error };
  }

  #healthOf(failure: ResendFailure): HealthReport {
    switch (failure.name) {
      case "restricted_api_key":
        // A sending-only key can't list domains, and that's the key ostra should hold. It can send.
        return { status: "ok" };
      case "missing_api_key":
      case "invalid_api_key":
        return { status: "down", reason: "Resend refused the API key" };
      case "rate_limit_exceeded":
        return { status: "degraded", reason: "Resend's rate limit is reached" };
      default:
        break;
    }
    if (failure.statusCode === 401 || failure.statusCode === 403) {
      return { status: "down", reason: "Resend refused the API key" };
    }
    if (failure.statusCode === 429) {
      return { status: "degraded", reason: "Resend's rate limit is reached" };
    }
    return { status: "down", reason: "Resend couldn't be reached or failed" };
  }
}
