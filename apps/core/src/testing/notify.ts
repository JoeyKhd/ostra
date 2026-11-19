import { randomUUID } from "node:crypto";

import { adapterError, NotificationAdapter, ok } from "@ostra/adapter-sdk";
import type { AdapterError, AdapterResult, BoardRef, HealthReport, Notification, NotificationCapabilities, SendResult, TrackerAdapter } from "@ostra/adapter-sdk";
import { adfToMarkdown } from "@ostra/adapter-sdk/testing";
import type { JiraSite } from "@ostra/adapter-sdk/testing";
import type { Db } from "@ostra/db";
import { notificationDeliveryIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { ExternalTicketId, NotificationDeliveryId, OrganizationId } from "@ostra/protocol";

import type { ChannelOutcome, NotificationChannels } from "../notifications/deliver.ts";

// Test channels for the notification tests of core (tickets 20, 21): a recorder that stands for a
// channel's adapter, and a tracker comment notifier on any `TrackerAdapter`, as ticket 11's real
// one is. The recorders keep what they were sent, so a test can count sends and read the words.

/** A notifier that records what it's sent, and fails on demand. */
export class RecordingNotifier extends NotificationAdapter {
  readonly name: string;
  readonly capabilities: NotificationCapabilities;
  readonly sent: Notification[] = [];
  readonly updated: { readonly notification: Notification; readonly providerMessageId: string }[] = [];
  /** The next sends fail with this, until it's cleared. */
  failWith: AdapterError | null = null;

  constructor(readonly channel: string, edits = false) {
    super();
    this.name = `recording-${channel}`;
    this.capabilities = { channels: [channel], edits };
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  send(notification: Notification): Promise<AdapterResult<SendResult>> {
    if (this.failWith !== null) {
      return Promise.resolve({ ok: false, error: this.failWith });
    }
    this.sent.push(notification);
    return Promise.resolve(ok({ providerMessageId: `${this.channel}-${randomUUID()}`, refused: [] }));
  }

  override update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    if (!this.capabilities.edits) {
      return super.update(notification, providerMessageId);
    }
    this.updated.push({ notification, providerMessageId });
    return Promise.resolve(ok(undefined));
  }
}

/** The words of a ticket comment for a notification: the moment, the mentions, the task's title in quotes and its link. */
const commentOf = (notification: Notification): string =>
  [
    `**${notification.title}**: "${notification.subject}"`,
    notification.body,
    notification.recipients.flatMap((recipient) => (recipient.trackerMention === null ? [] : [recipient.trackerMention])).join(" "),
    notification.url,
  ]
    .filter((part) => part !== "")
    .join("\n");

/** What ticket 11's tracker notification adapter does, on any `TrackerAdapter`: one comment per key, edited on `update`. */
export class CommentNotifier extends NotificationAdapter {
  readonly name = "recording-tracker";
  readonly capabilities: NotificationCapabilities = { channels: ["tracker"], edits: true };
  readonly keys = new Map<string, string>();
  sends = 0;
  /** The next sends fail with this, until it's cleared. */
  failWith: AdapterError | null = null;
  /** Runs after a comment is posted, before `send` answers: where a test answers the item meanwhile. */
  afterPost: (() => Promise<void>) | null = null;

  constructor(
    private readonly tracker: TrackerAdapter,
    private readonly board: BoardRef,
  ) {
    super();
  }

  health(): Promise<HealthReport> {
    return Promise.resolve({ status: "ok" });
  }

  async send(notification: Notification): Promise<AdapterResult<SendResult>> {
    const known = this.keys.get(notification.idempotencyKey);
    if (known !== undefined) {
      return ok({ providerMessageId: known, refused: [] });
    }
    if (this.failWith !== null) {
      return { ok: false, error: this.failWith };
    }
    if (notification.ticket === null || notification.ticket === undefined || !("key" in notification.ticket)) {
      return adapterError("invalid-input", "the notification has no ticket key");
    }
    const posted = await this.tracker.comment(this.board, notification.ticket.key, commentOf(notification));
    if (!posted.ok) {
      return posted;
    }
    this.sends += 1;
    this.keys.set(notification.idempotencyKey, posted.value.commentId);
    await this.afterPost?.();
    return ok({ providerMessageId: posted.value.commentId, refused: [] });
  }

  override async update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    if (notification.ticket === null || notification.ticket === undefined) {
      return adapterError("invalid-input", "the notification has no ticket");
    }
    return this.tracker.updateComment(this.board, notification.ticket, providerMessageId, commentOf(notification));
  }
}

export type TestChannels = {
  readonly channels: NotificationChannels;
  readonly panel: RecordingNotifier;
  /** The tracker notifiers built so far, one per delivery that reached the tracker. */
  readonly trackerNotifiers: readonly CommentNotifier[];
};

/** Channels for a test: the panel's recorder, and a comment notifier on whatever tracker the delivery found. */
export const testChannels = (): TestChannels => {
  const panel = new RecordingNotifier("panel", true);
  const trackerNotifiers: CommentNotifier[] = [];
  // One notifier per board, so a key sent twice is recognised, as the real adapter's idempotency store does.
  const byBoard = new Map<string, CommentNotifier>();
  return {
    panel,
    trackerNotifiers,
    channels: {
      panel: () => panel,
      tracker: ({ tracker, board }) => {
        const existing = byBoard.get(board.externalId);
        if (existing !== undefined) {
          return existing;
        }
        const made = new CommentNotifier(tracker, board);
        byBoard.set(board.externalId, made);
        trackerNotifiers.push(made);
        return made;
      },
    },
  };
};

/** An email channel that always answers the same, and counts what it was asked. */
export const fixedEmailChannel = (outcome: ChannelOutcome): { readonly deliver: () => Promise<ChannelOutcome>; readonly calls: () => number } => {
  let count = 0;
  return {
    deliver: () => {
      count += 1;
      return Promise.resolve(outcome);
    },
    calls: () => count,
  };
};

/** The comments on a Jira issue, as Markdown. */
export const commentsOf = (site: JiraSite, externalId: ExternalTicketId): readonly string[] =>
  (site.issues.get(externalId)?.comments ?? []).map((comment) => adfToMarkdown(comment.body));

/** The `notify.deliver` jobs sitting in the queue that a test hasn't run yet. */
export const queuedDeliveries = async (
  db: Db,
  taken: Set<string>,
): Promise<readonly { readonly jobId: string; readonly organizationId: OrganizationId; readonly deliveryId: NotificationDeliveryId; readonly startAfter: Date }[]> => {
  const rows = await db.$queryRaw<readonly { readonly id: string; readonly data: unknown; readonly start_after: Date }[]>`
    SELECT id::text AS id, data, start_after FROM pgboss.job WHERE name = 'notify.deliver' AND state IN ('created', 'retry') ORDER BY created_on, id`;
  return rows
    .filter((row) => !taken.has(row.id))
    .map((row) => {
      taken.add(row.id);
      const data = row.data;
      if (typeof data !== "object" || data === null || !("organizationId" in data) || !("deliveryId" in data)) {
        throw new Error("a notify.deliver job without its payload");
      }
      return {
        jobId: row.id,
        organizationId: organizationIdSchema.parse(data.organizationId),
        deliveryId: notificationDeliveryIdSchema.parse(data.deliveryId),
        startAfter: row.start_after,
      };
    });
};

/** The changes of an item the queue holds a `notify.fanout` job for: `created`, `answered`, `dismissed`. */
export const fanoutChangesOf = async (db: Db, itemId: string): Promise<readonly string[]> => {
  const rows = await db.$queryRaw<readonly { readonly change: string }[]>`
    SELECT data->>'change' AS change FROM pgboss.job WHERE name = 'notify.fanout' AND data->>'needsYouItemId' = ${itemId} ORDER BY created_on, id`;
  return rows.map((row) => row.change);
};
