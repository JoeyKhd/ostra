import { adapterError, idempotencyKey, NotificationAdapter, ok, refuseAccountMail } from "@ostra/adapter-sdk";
import type {
  AdapterContext,
  AdapterError,
  AdapterResult,
  BoardRef,
  HealthReport,
  MomentNotification,
  Notification,
  NotificationCapabilities,
  SendResult,
  TicketRef,
  TrackerAdapter,
} from "@ostra/adapter-sdk";
import { memberIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { renderTrackerComment, usableMentions } from "./comment-text.ts";

// The ticket channel (ADR 0050): a comment on the task's ticket, through the board's own
// `TrackerAdapter`, so it works for Linear and for the Jira fake alike (adapter parity). A comment
// is what a tracker notifies people about: the audience is mentioned in it, where the tracker has a
// user for the member's address (core asks `findUsersByEmail` and hands the markdown over in each
// recipient's `trackerMention`). A recipient without a mention isn't refused: the comment is on the
// ticket for everyone who watches it, and only the mention is missing.
//
// One comment per key. A moment within the coalescing window edits the last comment instead
// (`update`), and an answer edits it to say it was answered. The comment's text is the pure
// renderer's (`comment-text.ts`), never agent output. Logs carry IDs, never the text.

export type TrackerNotificationAdapterOptions = {
  /** The board's tracker adapter, built for the organization by core. */
  readonly tracker: TrackerAdapter;
  /** The board the tasks' tickets live on. */
  readonly board: BoardRef;
};

// What a finished send records, to answer it again for the same key.
const recordedSendSchema = z.object({
  providerMessageId: z.string().min(1).nullable(),
  refused: z.array(z.object({ memberId: memberIdSchema, reason: z.string() })),
});

/** A tracker call that failed inside an idempotent send: thrown so the key's claim is released. */
class TrackerCallFailed extends Error {
  readonly failure: AdapterError;
  constructor(failure: AdapterError) {
    super(failure.message);
    this.failure = failure;
  }
}

const fail = <T,>(error: AdapterError): AdapterResult<T> => ({ ok: false, error });

export class TrackerNotificationAdapter extends NotificationAdapter {
  readonly name = "tracker";
  readonly capabilities: NotificationCapabilities;

  readonly #tracker: TrackerAdapter;
  readonly #board: BoardRef;

  constructor(options: TrackerNotificationAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#tracker = options.tracker;
    this.#board = options.board;
    // It edits where the tracker lets ostra edit its own comment (adapter parity: declared, never assumed).
    this.capabilities = { channels: ["tracker"], edits: options.tracker.capabilities.commentEdit };
  }

  health(): Promise<HealthReport> {
    return this.#tracker.health();
  }

  async send(notification: Notification): Promise<AdapterResult<SendResult>> {
    // Milestone 4: an account mail carries a bearer link, and never goes on a ticket.
    if (notification.category === "account") {
      return refuseAccountMail("tracker");
    }
    const ticket = notification.ticket;
    if (ticket === undefined || ticket === null) {
      return adapterError("invalid-input", "a ticket notification needs the task's ticket");
    }
    const markdown = this.#markdown(notification);
    if (markdown === undefined) {
      return adapterError("invalid-input", "the task's link isn't a web address");
    }
    const key = idempotencyKey("notify-tracker", notification.organizationId, notification.idempotencyKey);
    let outcome;
    try {
      outcome = await this.plumbing.once(key, async (): Promise<SendResult> => {
        const posted = await this.#post(ticket, markdown);
        if (!posted.ok) {
          throw new TrackerCallFailed(posted.error);
        }
        return { providerMessageId: posted.value, refused: [] };
      });
    } catch (error) {
      if (error instanceof TrackerCallFailed) {
        this.plumbing.logger.warn("tracker_notification.failed", { code: error.failure.code, kind: notification.kind });
        return fail(error.failure);
      }
      throw error;
    }
    switch (outcome.kind) {
      case "ran":
        this.plumbing.logger.info("tracker_notification.posted", { kind: notification.kind, mentions: this.#mentions(notification).length });
        return ok(outcome.result);
      case "replayed": {
        const recorded = recordedSendSchema.safeParse(outcome.result);
        return recorded.success ? ok(recorded.data) : adapterError("invalid-response", "the recorded send of this notification can't be read");
      }
      case "in-doubt":
        // Another attempt claimed the key and never finished: the comment may or may not be on the
        // ticket, and a second one would notify the team twice. Better a failed delivery than that.
        this.plumbing.logger.warn("tracker_notification.in_doubt", { kind: notification.kind, claimedAt: outcome.claimedAt });
        return adapterError("conflict", "an earlier send of this notification didn't finish, so it isn't posted again");
      default:
        return outcome satisfies never;
    }
  }

  override async update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    if (notification.category === "account") {
      return refuseAccountMail("tracker");
    }
    if (!this.capabilities.edits) {
      return super.update(notification, providerMessageId);
    }
    const ticket = notification.ticket;
    if (ticket === undefined || ticket === null) {
      return adapterError("invalid-input", "a ticket notification needs the task's ticket");
    }
    const markdown = this.#markdown(notification);
    if (markdown === undefined) {
      return adapterError("invalid-input", "the task's link isn't a web address");
    }
    const edited = await this.#tracker.updateComment(this.#board, ticket, providerMessageId, markdown);
    if (!edited.ok) {
      this.plumbing.logger.warn("tracker_notification.update_failed", { code: edited.error.code, kind: notification.kind });
      return edited;
    }
    this.plumbing.logger.info("tracker_notification.edited", { kind: notification.kind, state: notification.state ?? "open" });
    return ok(undefined);
  }

  #mentions(notification: MomentNotification): readonly string[] {
    return usableMentions(notification.recipients.map((recipient) => recipient.trackerMention));
  }

  #markdown(notification: MomentNotification): string | undefined {
    return renderTrackerComment({
      title: notification.title,
      subject: notification.subject,
      body: notification.body,
      url: notification.url,
      state: notification.state ?? "open",
      mentions: this.#mentions(notification),
    });
  }

  /** Posts the comment and answers its ID. A ticket known by its stable ID is looked up for its key first. */
  async #post(ticket: TicketRef, markdown: string): Promise<AdapterResult<string>> {
    let key;
    if ("key" in ticket) {
      key = ticket.key;
    } else {
      const found = await this.#tracker.getTicket(this.#board, ticket);
      if (!found.ok) {
        return found;
      }
      key = found.value.key;
    }
    const posted = await this.#tracker.comment(this.#board, key, markdown);
    return posted.ok ? ok(posted.value.commentId) : posted;
  }
}
