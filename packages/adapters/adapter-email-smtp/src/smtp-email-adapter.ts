import { createHash } from "node:crypto";

import { adapterError, idempotencyKey, NotificationAdapter, ok } from "@ostra/adapter-sdk";
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
import { createTransport } from "nodemailer";
import type { Mail, SMTPPoolOptions, SMTPPoolSentMessageInfo } from "nodemailer";
import { z } from "zod";

// The SMTP email adapter (ADR 0007, ADR 0050, F-115): the second email option, for installs with
// their own mail relay or no internet. It sends the notification's rendered subject, HTML and text
// from the configured address, one message per recipient, so one refused address never hides
// another, on nodemailer's pooled transport.
//
// A password never crosses a network in clear: `tls` (SMTPS) and `starttls` both encrypt before
// they sign in, `starttls` sends nothing at all when the server won't upgrade (it never falls back
// to plain text), and `none` is refused unless the host is this machine. The server's certificate
// is always checked; `tlsCa` adds a trusted certificate for a relay with a private CA.
//
// Each message's `Message-ID` is made from the notification's key and the recipient, so a retry
// that does mail twice (a crash between the server's "250" and ostra's record of it) sends the same
// ID and a mail client can fold the copies. The adapter never logs or puts in an error the
// password, an address or a word of the mail: errors are in words of its own.

export const smtpSecureModes = ["tls", "starttls", "none"] as const;
export type SmtpSecure = (typeof smtpSecureModes)[number];

export type SmtpEmailAdapterOptions = {
  /** The relay's host name or address. */
  readonly host: string;
  readonly port: number;
  /** `tls`: encrypted from the first byte (port 465). `starttls`: upgraded before sign-in (587), or nothing is sent. `none`: plain text, loopback only. */
  readonly secure: SmtpSecure;
  /** The account to sign in as. Absent: the relay takes mail without a sign-in. */
  readonly user?: string;
  /** Its password, from the secret store through core. Never logged. */
  readonly password?: string;
  /** The address mail comes from. */
  readonly from: string;
  /** The name mail comes from. Default `ostra`. */
  readonly fromName?: string;
  /** A PEM certificate to trust besides the system's, for a relay with a private CA. */
  readonly tlsCa?: string;
  /** How long to wait for a connection and a greeting, in ms. Default 15,000. */
  readonly timeoutMs?: number;
};

const DEFAULT_FROM_NAME = "ostra";
const DEFAULT_TIMEOUT_MS = 15_000;
/** How long one connection may sit silent mid-message. */
const SOCKET_TIMEOUT_MS = 60_000;
/** What a 4xx reply waits before a retry: the server said "try again later" and not when. */
const TRY_AGAIN_MS = 60_000;
const MAX_CONNECTIONS = 2;

/** The display name of the sender, made safe for an address header. */
const cleanName = (name: string): string =>
  name
    .replaceAll(/["<>,\r\n]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const ADDRESS = /^[^\s@<>,]+@([^\s@<>,]+\.[^\s@<>,]+)$/;

/** The domain of a plain address, or `undefined` when it isn't one. */
const domainOf = (address: string): string | undefined => ADDRESS.exec(address.trim())?.[1]?.toLowerCase();

/** Whether a host is this machine: `localhost`, `127.x.x.x` or `::1`. */
export const isLoopbackHost = (host: string): boolean => {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
};

/** Why these settings can't be used, in words, or `null` when they can. Core checks it when an admin saves them. */
export const smtpSettingsProblem = (options: SmtpEmailAdapterOptions): string | null => {
  if (options.host.trim() === "") return "the SMTP host is empty";
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return "the SMTP port isn't a port number";
  if (domainOf(options.from) === undefined) return "the from address isn't an email address";
  if (options.secure === "none" && !isLoopbackHost(options.host)) {
    return "plain-text SMTP is only allowed to this machine: use tls or starttls so the password isn't sent in clear";
  }
  if ((options.user ?? "") !== "" && (options.password ?? "") === "") return "the SMTP user has no password";
  if ((options.user ?? "") === "" && (options.password ?? "") !== "") return "the SMTP password has no user";
  return null;
};

/** The same for every message of one notification, a hash of its key: a mail client can group them, and the key itself stays out. */
const notificationTag = (notificationKey: string): string => createHash("sha256").update(`tag:${notificationKey}`).digest("hex").slice(0, 32);

/** The `Message-ID` of one recipient's mail: the same for a retry of the same key. */
export const smtpMessageId = (notificationKey: string, memberId: string, domain: string): string => {
  const digest = createHash("sha256").update(`${notificationKey}\u0000${memberId}`).digest("hex").slice(0, 40);
  return `<ostra.${digest}@${domain}>`;
};

/** What nodemailer's error says that ostra acts on. */
const failureSchema = z.looseObject({
  code: z.string().optional(),
  responseCode: z.number().optional(),
  command: z.string().optional(),
  message: z.string().optional(),
});
type SmtpFailure = z.infer<typeof failureSchema>;

const failureOf = (error: unknown): SmtpFailure => {
  const parsed = failureSchema.safeParse(error);
  return parsed.success ? parsed.data : {};
};

/**
 * What went wrong with the connection or the sign-in, as ostra tells it. nodemailer folds a refused
 * connection and a rejected certificate into one `ESOCKET`, so the two are told apart by the words
 * of its message, which are read here and never passed on.
 */
type Trouble = "auth" | "tls" | "timeout" | "dns" | "refused" | "closed";

const troubleOf = (failure: SmtpFailure): Trouble | null => {
  switch (failure.code) {
    case "EAUTH":
    case "ENOAUTH":
    case "EOAUTH2":
      return "auth";
    case "ETLS":
    case "EREQUIRETLS":
      return "tls";
    case "ETIMEDOUT":
      return "timeout";
    case "EDNS":
      return "dns";
    case "ECONNECTION":
    case "ESOCKET":
    case "EPROTOCOL":
      break;
    case undefined:
    default:
      return null;
  }
  if (failure.responseCode !== undefined) {
    return null;
  }
  const message = failure.message ?? "";
  if (/certificate|altnames|self.signed|\bTLS\b|\bSSL\b|handshake|wrong version number/i.test(message)) return "tls";
  if (message.includes("ECONNREFUSED")) return "refused";
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return "dns";
  if (/ETIMEDOUT|timed out|timeout/i.test(message)) return "timeout";
  return "closed";
};

/** One recipient's outcome: sent (the Message-ID), refused (theirs alone) or a failure of the adapter's. */
type RecipientOutcome =
  | { readonly kind: "sent"; readonly id: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: AdapterError };

/** What a finished recipient leaves in the idempotency store (a failure leaves nothing, so a retry sends it). */
const recordedSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sent"), id: z.string() }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
]);
type Recorded = z.infer<typeof recordedSchema>;

/** Carries a failure out of the idempotent call, so the claim is released and the retry sends again. */
class SendFailed extends Error {
  readonly failure: AdapterError;
  constructor(failure: AdapterError) {
    super(failure.message);
    this.failure = failure;
  }
}

const unavailable = (message: string, retryAfterMs?: number): AdapterError => adapterError("unavailable", message, retryAfterMs).error;

/** Sorts a failed send: the recipient's own, or the adapter's. */
const classifySmtpFailure = (error: unknown): RecipientOutcome => {
  const failure = failureOf(error);
  const reply = failure.responseCode;
  const trouble = troubleOf(failure);
  switch (trouble) {
    case "auth":
      return { kind: "failed", error: adapterError("unauthorized", "the SMTP server refused the user name or password").error };
    case "tls":
      return { kind: "failed", error: unavailable("TLS failed: the server wouldn't start TLS, or its certificate isn't trusted. Nothing was sent") };
    case "timeout":
      return { kind: "failed", error: unavailable("the SMTP server took too long to answer") };
    case "dns":
      return { kind: "failed", error: unavailable("the SMTP host's name couldn't be found") };
    case "refused":
      return { kind: "failed", error: unavailable("the SMTP server refused the connection") };
    case "closed":
      return { kind: "failed", error: unavailable("the SMTP server couldn't be reached, or closed the connection") };
    case null:
      break;
    default:
      return trouble satisfies never;
  }
  if (reply !== undefined && reply >= 400 && reply < 500) {
    // A 4xx reply is the server saying "not now" (a busy mailbox, greylisting, a limit): retryable.
    return { kind: "failed", error: unavailable(`the SMTP server asked to try again later (${String(reply)})`, TRY_AGAIN_MS) };
  }
  if (reply === 530 || reply === 535) {
    return { kind: "failed", error: adapterError("unauthorized", "the SMTP server wants a sign-in, or refused it").error };
  }
  if (reply !== undefined && reply >= 500) {
    if (failure.command === "RCPT TO") {
      return { kind: "refused", reason: `the SMTP server refused the member's email address (${String(reply)})` };
    }
    if (failure.command === "MAIL FROM") {
      return { kind: "failed", error: adapterError("forbidden", `the SMTP server refused the from address (${String(reply)})`).error };
    }
    return { kind: "failed", error: adapterError("forbidden", `the SMTP server refused the mail (${String(reply)})`).error };
  }
  if (failure.code === "EENVELOPE") {
    // nodemailer refused an address before any call: the only one a send varies is the recipient's.
    return { kind: "refused", reason: "the member's email address isn't valid" };
  }
  return { kind: "failed", error: unavailable("the SMTP send failed") };
};

export class SmtpEmailAdapter extends NotificationAdapter {
  readonly name = "smtp";
  readonly capabilities: NotificationCapabilities = { channels: ["email"], edits: false };

  readonly #options: SmtpEmailAdapterOptions;
  readonly #problem: string | null;
  readonly #from: { readonly name: string; readonly address: string };
  readonly #domain: string;
  readonly #transport: Mail<SMTPPoolSentMessageInfo, SMTPPoolOptions> | null;

  constructor(options: SmtpEmailAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#options = options;
    this.#problem = smtpSettingsProblem(options);
    this.#domain = domainOf(options.from) ?? "localhost";
    this.#from = { name: cleanName(options.fromName ?? DEFAULT_FROM_NAME) || DEFAULT_FROM_NAME, address: options.from.trim() };
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // With settings that can't be used there is no transport, so nothing is ever connected to.
    this.#transport =
      this.#problem === null
        ? createTransport({
            pool: true,
            host: options.host.trim(),
            port: options.port,
            // Encrypted before anything else, or upgraded before sign-in and never sent without it, or (loopback only) plain.
            secure: options.secure === "tls",
            requireTLS: options.secure === "starttls",
            ignoreTLS: options.secure === "none",
            ...((options.user ?? "") === "" ? {} : { auth: { user: options.user ?? "", pass: options.password ?? "" } }),
            // The certificate is always checked; a private CA is added, never skipped.
            ...(options.tlsCa === undefined ? {} : { tls: { ca: options.tlsCa } }),
            connectionTimeout: timeout,
            greetingTimeout: timeout,
            socketTimeout: SOCKET_TIMEOUT_MS,
            maxConnections: MAX_CONNECTIONS,
            // The password must not reach nodemailer's own logs, and a mail names no file or URL to read.
            logger: false,
            debug: false,
            disableFileAccess: true,
            disableUrlAccess: true,
          })
        : null;
  }

  /** Closes the pooled connections. Call it when the adapter is dropped. */
  close(): void {
    this.#transport?.close();
  }

  async health(): Promise<HealthReport> {
    if (this.#problem !== null || this.#transport === null) {
      return { status: "down", reason: this.#problem ?? "the SMTP settings can't be used" };
    }
    try {
      await this.#transport.verify();
      return { status: "ok" };
    } catch (error) {
      return { status: "down", reason: this.#healthReason(error) };
    }
  }

  async send(notification: Notification): Promise<AdapterResult<SendResult>> {
    const rendered = notification.rendered;
    if (rendered === null) {
      return adapterError("invalid-input", "an email needs its rendered subject, HTML and text");
    }
    if (this.#problem !== null || this.#transport === null) {
      return adapterError("invalid-input", this.#problem ?? "the SMTP settings can't be used");
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
    // One at a time: a failure then names the recipient it stopped at, and those already mailed are recorded.
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
          this.plumbing.logger.warn("smtp.send_failed", { kind: notification.kind, code: outcome.error.code, sent: providerMessageId === null ? 0 : 1 });
          // Anyone mailed already is recorded: the retry sends only to the rest.
          return { ok: false, error: outcome.error };
        default:
          return outcome satisfies never;
      }
    }
    this.plumbing.logger.info("smtp.sent", { kind: notification.kind, recipients: sendable.length, refused: refused.length });
    return ok({ providerMessageId, refused });
  }

  async #sendOne(
    notification: Notification,
    rendered: { readonly subject: string; readonly html: string; readonly text: string },
    recipient: NotificationRecipient,
    address: string,
  ): Promise<RecipientOutcome> {
    const messageId = smtpMessageId(notification.idempotencyKey, recipient.memberId, this.#domain);
    const tag = notificationTag(notification.idempotencyKey);
    const key = idempotencyKey("email-smtp", notification.organizationId, notification.idempotencyKey, recipient.memberId);
    const transmit = async (): Promise<Recorded> => {
      const outcome = await this.#transmit(rendered, address, messageId, tag);
      if (outcome.kind === "failed") {
        throw new SendFailed(outcome.error);
      }
      return outcome;
    };
    try {
      const once = await this.plumbing.once(key, transmit);
      switch (once.kind) {
        case "ran":
          return once.result;
        case "replayed": {
          const recorded = recordedSchema.safeParse(once.result);
          return recorded.success ? recorded.data : await this.#transmit(rendered, address, messageId, tag);
        }
        case "in-doubt":
          // An attempt claimed the key and never finished: it may or may not have mailed. SMTP can't be asked, so
          // send again with the same Message-ID, which a mail client folds into the first copy.
          return await this.#transmit(rendered, address, messageId, tag);
        default:
          return once satisfies never;
      }
    } catch (error) {
      if (error instanceof SendFailed) {
        return { kind: "failed", error: error.failure };
      }
      throw error;
    }
  }

  async #transmit(
    rendered: { readonly subject: string; readonly html: string; readonly text: string },
    address: string,
    messageId: string,
    tag: string,
  ): Promise<RecipientOutcome> {
    if (this.#transport === null) {
      return { kind: "failed", error: adapterError("invalid-input", "the SMTP settings can't be used").error };
    }
    try {
      await this.#transport.sendMail({
        from: this.#from,
        to: address,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        messageId,
        headers: { "Auto-Submitted": "auto-generated", "X-Ostra-Notification": tag },
      });
      return { kind: "sent", id: messageId };
    } catch (error) {
      return classifySmtpFailure(error);
    }
  }

  /** What `verify()` failed on, in words: refused, signed out, TLS. Never the password or the server's own text. */
  #healthReason(error: unknown): string {
    const failure = failureOf(error);
    const where = `${this.#options.host}:${String(this.#options.port)}`;
    const trouble = troubleOf(failure);
  switch (trouble) {
      case "auth":
        return `${where} refused the user name or password`;
      case "tls":
        return `TLS to ${where} failed: the server wouldn't start TLS, or its certificate isn't trusted`;
      case "timeout":
        return `${where} took too long to answer`;
      case "dns":
        return `the host name ${this.#options.host} couldn't be found`;
      case "refused":
        return `${where} refused the connection`;
      case "closed":
        return `${where} couldn't be reached, or closed the connection`;
      case null:
        break;
      default:
        return trouble satisfies never;
    }
    if (failure.responseCode !== undefined && failure.responseCode >= 400) {
      return `${where} answered ${String(failure.responseCode)} and wouldn't take the connection`;
    }
    return `${where} failed the check`;
  }
}
