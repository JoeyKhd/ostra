import { createHash } from "node:crypto";

import { adapterError, idempotencyKey, NotificationAdapter, ok, parseVendor, refuseAccountMail } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  HealthReport,
  Notification,
  NotificationCapabilities,
  RefusedRecipient,
  SendResult,
} from "@ostra/adapter-sdk";
import { memberIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { slackCheck, slackPostMessage, slackUpdateMessage } from "./client.ts";
import type { SlackApiOptions } from "./client.ts";

// The Slack channel (F-057, spec section 4.3; ADR 0074): one direct message per member from the
// organization's bot. Core builds this adapter per delivery from the installation's bot token and
// passes each recipient's workspace user ID; this adapter opens the DM with that ID, posts the
// notification's words, and keeps the DM's `D…` channel and the message's `ts` as the provider ID
// `chat.update` needs.
//
// The token is a secret: it is never logged, never in an error, and the rate budget is named by its
// digest, as Linear's is. Slack's own error codes are mapped once (`slackErrorOf`), and a member
// Slack doesn't know is that member's refusal, not the send's failure.

export type SlackNotificationAdapterOptions = {
  /** Slack's Web API root. Default `https://slack.com/api`; a test points it at the fake. */
  readonly apiUrl?: string;
  /** The installation's bot token, from the secret store. Never logged. */
  readonly token: string;
  /** How long one call may take, in ms. Default 15,000. */
  readonly timeoutMs?: number;
};

const postedMessageSchema = z.looseObject({
  channel: z.string().regex(/^D[A-Za-z0-9]+$/),
  ts: z.string().regex(/^\d+\.\d+$/),
});

const updatedMessageSchema = z.looseObject({ channel: z.string(), ts: z.string() });

/** `slack:<the DM's D… channel>:<the message's ts>`, the two fields `chat.update` needs. */
const providerMessageIdSchema = z.string().regex(/^slack:D[A-Za-z0-9]+:\d+\.\d+$/);

const recordedSendSchema = z.looseObject({
  providerMessageId: z.string().nullable(),
  refused: z.array(z.looseObject({ memberId: memberIdSchema.nullable(), reason: z.string().min(1) })),
});

/** A send that stopped on an error the whole notification shares, thrown to release the idempotency key. */
class SlackSendFailed extends Error {
  readonly failure: AdapterError;

  constructor(failure: AdapterError) {
    super(failure.message);
    this.failure = failure;
  }
}

export class SlackNotificationAdapter extends NotificationAdapter {
  readonly name = "slack";
  readonly capabilities: NotificationCapabilities = { channels: ["slack"], edits: true };

  readonly #token: string;
  readonly #apiUrl: string | undefined;
  readonly #timeoutMs: number | undefined;
  /** The budget is per credential: named by a digest of the token, never by the token. */
  readonly #budgetKey: string;

  constructor(options: SlackNotificationAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#token = options.token;
    this.#apiUrl = options.apiUrl;
    this.#timeoutMs = options.timeoutMs;
    this.#budgetKey = `slack:${createHash("sha256").update(options.token).digest("hex").slice(0, 16)}`;
  }

  async health(): Promise<HealthReport> {
    const checked = await slackCheck(this.#api());
    return checked.ok ? { status: "ok" } : { status: "down", reason: checked.error.message };
  }

  async send(notification: Notification): Promise<AdapterResult<SendResult>> {
    if (notification.category === "account") {
      return refuseAccountMail("slack");
    }
    if (this.#token === "") {
      return adapterError("unauthorized", "the Slack adapter needs a bot token");
    }
    if (notification.recipients.length === 0) {
      return adapterError("invalid-input", "a Slack notification needs at least one recipient");
    }
    const key = idempotencyKey("notify-slack", notification.organizationId, notification.idempotencyKey);
    let outcome;
    try {
      outcome = await this.plumbing.once(key, async (): Promise<SendResult> => this.#deliver(notification));
    } catch (error) {
      if (error instanceof SlackSendFailed) {
        this.plumbing.logger.warn("slack.send_failed", { kind: notification.kind, code: error.failure.code });
        return { ok: false, error: error.failure };
      }
      throw error;
    }
    switch (outcome.kind) {
      case "ran":
        this.plumbing.logger.info("slack.sent", {
          kind: notification.kind,
          recipients: notification.recipients.length,
          refused: outcome.result.refused.length,
        });
        return ok(outcome.result);
      case "replayed": {
        const recorded = recordedSendSchema.safeParse(outcome.result);
        if (!recorded.success) {
          return adapterError("invalid-response", "the recorded send of this notification can't be read");
        }
        return ok(recorded.data);
      }
      case "in-doubt":
        this.plumbing.logger.warn("slack.send_in_doubt", { kind: notification.kind, claimedAt: outcome.claimedAt });
        return adapterError("conflict", "an earlier send of this notification didn't finish, so it isn't posted again");
      default:
        return outcome satisfies never;
    }
  }

  override async update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    if (notification.category === "account") {
      return refuseAccountMail("slack");
    }
    const parsedId = providerMessageIdSchema.safeParse(providerMessageId);
    if (!parsedId.success) {
      return adapterError("invalid-input", "a Slack message ID is slack:<D channel>:<ts>");
    }
    const parts = parsedId.data.split(":");
    const channel = parts[1];
    const ts = parts[2];
    if (channel === undefined || ts === undefined) {
      return adapterError("invalid-input", "a Slack message ID is slack:<D channel>:<ts>");
    }
    const limited = await this.#rateLimited();
    if (limited !== null) {
      return { ok: false, error: limited };
    }
    const answer = await slackUpdateMessage(this.#api(), { channel, ts, text: notification.body });
    if (!answer.ok) {
      if (answer.failure.slackError === "cant_update_message" || answer.failure.slackError === "message_not_found") {
        this.plumbing.logger.warn("slack.update_failed", { kind: notification.kind, code: answer.failure.slackError });
        return adapterError("not-found", `Slack has no message to edit (${answer.failure.slackError})`);
      }
      this.plumbing.logger.warn("slack.update_failed", { kind: notification.kind, code: answer.failure.error.code });
      return { ok: false, error: answer.failure.error };
    }
    const narrowed = parseVendor(updatedMessageSchema, answer.data, "Slack's chat.update answer");
    if (!narrowed.ok) {
      return narrowed;
    }
    this.plumbing.logger.info("slack.updated", { kind: notification.kind, state: notification.state ?? "open" });
    return ok(undefined);
  }

  async #deliver(notification: Notification): Promise<SendResult> {
    if (notification.category === "account") {
      // Unreachable: `send` refuses an account mail before `once`. Keeps the narrowing local.
      throw new SlackSendFailed(refuseAccountMail("slack").error);
    }
    const refused: RefusedRecipient[] = [];
    let providerMessageId: string | null = null;
    for (const recipient of notification.recipients) {
      // The member's workspace user ID, `NotificationRecipient.slackUserId` (ticket 04). Read
      // structurally so this package stands alone until that field lands in the SDK's type.
      const raw: unknown = Reflect.get(recipient, "slackUserId");
      const slackUserId = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      if (slackUserId === null) {
        refused.push({ memberId: recipient.memberId, reason: "The member has no Slack account" });
        continue;
      }
      const limited = await this.#rateLimited();
      if (limited !== null) {
        throw new SlackSendFailed(limited);
      }
      const answer = await slackPostMessage(this.#api(), { channel: slackUserId, text: notification.body });
      if (!answer.ok) {
        if (answer.failure.slackError === "channel_not_found" || answer.failure.slackError === "users_not_found") {
          refused.push({
            memberId: recipient.memberId,
            reason:
              answer.failure.slackError === "users_not_found"
                ? "The member has no Slack account"
                : "The member has no Slack account in this workspace",
          });
          continue;
        }
        throw new SlackSendFailed(answer.failure.error);
      }
      const posted = parseVendor(postedMessageSchema, answer.data, "Slack's chat.postMessage answer");
      if (!posted.ok) {
        throw new SlackSendFailed(posted.error);
      }
      providerMessageId ??= `slack:${posted.value.channel}:${posted.value.ts}`;
    }
    return { providerMessageId, refused };
  }

  async #rateLimited(): Promise<AdapterError | null> {
    const budget = this.plumbing.rateBudget;
    if (budget === undefined) {
      return null;
    }
    const decision = await budget.check(this.#budgetKey);
    return decision.go ? null : adapterError("rate-limited", "Slack's rate limit is reached", decision.waitMs).error;
  }

  #api(): SlackApiOptions {
    return {
      token: this.#token,
      ...(this.#apiUrl === undefined ? {} : { apiUrl: this.#apiUrl }),
      ...(this.#timeoutMs === undefined ? {} : { timeoutMs: this.#timeoutMs }),
    };
  }
}
