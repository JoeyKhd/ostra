import type { AdapterError, BoardRef, Logger, Notification, NotificationAdapter, TrackerAdapter } from "@ostra/adapter-sdk";
import type { Db, Prisma } from "@ostra/db";
import {
  deliveryChangeOf,
  fanOutNotification,
  momentHeading,
  recordDelivery,
  trackerDelivery,
} from "@ostra/domain";
import type { AuditLog, ChangeNotices, Clock, CommandOutbox, DeliveryOutcome, DeliverySkipReason, JobQueue, ServerAdapters } from "@ostra/domain";
import { queueSettings } from "@ostra/jobs";
import type { JobHandler } from "@ostra/jobs";
import { connectionIdSchema, memberIdSchema, needsYouItemIdSchema, notificationDeliveryIdSchema, notificationIdSchema, organizationIdSchema, taskIdSchema, ticketKeySchema } from "@ostra/protocol";
import type { NotificationDeliveryId, OrganizationId } from "@ostra/protocol";

import type { ConnectionTrackers } from "../tracker/connections.ts";
import { taskUrlOf } from "../tracker/writer.ts";

// Delivery (F-036, ADR 0050, ticket 20): `notify.deliver` sends one delivery through its channel's
// adapter, records what happened on the delivery row, and never touches another channel's. The
// panel's adapter is the row itself; the ticket's is a comment through the board's own tracker,
// coalesced in a window by editing the last one; email is ticket 21's. A failing channel retries
// with backoff, and when its retries are used up the delivery is `failed`, with the error in words.
// Logs carry IDs, never the comment's text, a mail or an address.

/** What each channel's adapter is built from, per organization (ADR 0025). Tests pass recorders. */
export type NotificationChannels = {
  readonly panel: (organizationId: OrganizationId) => NotificationAdapter;
  readonly tracker: (input: { readonly organizationId: OrganizationId; readonly tracker: TrackerAdapter; readonly board: BoardRef }) => NotificationAdapter;
};

/** What one channel did with a delivery, before it's recorded. */
export type ChannelOutcome =
  | { readonly outcome: "sent"; readonly providerMessageId: string | null }
  | { readonly outcome: "skipped"; readonly why: DeliverySkipReason }
  | { readonly outcome: "failed"; readonly error: string; readonly retryable: boolean };

export const DELIVERY_SELECT = {
  id: true,
  organizationId: true,
  channel: true,
  adapter: true,
  state: true,
  idempotencyKey: true,
  providerMessageId: true,
  attempts: true,
  dueAt: true,
  notification: {
    select: {
      id: true,
      memberId: true,
      kind: true,
      state: true,
      readAt: true,
      needsYouItemId: true,
      member: { select: { user: { select: { email: true, name: true } } } },
      needsYouItem: { select: { id: true, state: true, reason: true, createdAt: true, resolvedByMemberId: true, approvalId: true, planTurnId: true } },
      task: {
        select: {
          id: true,
          title: true,
          ticketKey: true,
          driverMemberId: true,
          spentMicroUsd: true,
          project: { select: { id: true, name: true, organization: { select: { name: true } } } },
          ticket: { select: { externalId: true, key: true } },
          board: { select: { externalId: true, connectionId: true } },
        },
      },
    },
  },
} satisfies Prisma.NotificationDeliverySelect;

export type DeliveryRow = Prisma.NotificationDeliveryGetPayload<{ select: typeof DELIVERY_SELECT }>;

export type NotifyDeps = {
  readonly db: Db;
  readonly jobs: JobQueue;
  readonly notices: ChangeNotices;
  readonly outbox: CommandOutbox;
  readonly audit: AuditLog;
  readonly clock: Clock;
  readonly adapters: ServerAdapters;
  readonly logger: Logger;
  readonly trackers: ConnectionTrackers;
  readonly channels: NotificationChannels;
  /** The mail channel (ticket 21). */
  readonly email: EmailChannel;
  /** The panel's address, for the task's link. */
  readonly publicUrl: string;
  readonly emailDelaySeconds: number;
  readonly trackerCoalesceMinutes: number;
  /** `OSTRA_SESSION_STALL_MINUTES`, for the stall mail's one line. */
  readonly stallMinutes: number;
};

/** The mail channel: sends one email delivery, or says why it didn't. */
export type EmailChannel = {
  readonly deliver: (row: DeliveryRow) => Promise<ChannelOutcome>;
};

/** Mail with no provider: every delivery is skipped, in words (ticket 21 replaces it with the real one). */
export const mailOffChannel: EmailChannel = { deliver: () => Promise.resolve({ outcome: "skipped", why: "mail-off" }) };

/** Errors another attempt may fix, as in the tracker writer: the vendor is busy or away. */
const retryable = (error: AdapterError): boolean => {
  switch (error.code) {
    case "rate-limited":
    case "unavailable":
    case "invalid-response":
    case "aborted":
    case "unauthorized":
      return true;
    case "forbidden":
    case "not-found":
    case "invalid-input":
    case "conflict":
    case "unsupported":
      return false;
    default:
      return error.code satisfies never;
  }
};

const words = (error: AdapterError): string => `${error.code}: ${error.message}`.slice(0, 500);

export const loadDelivery = (db: Db, organizationId: OrganizationId, deliveryId: NotificationDeliveryId): Promise<DeliveryRow | null> =>
  db.notificationDelivery.findFirst({ where: { id: deliveryId, organizationId }, select: DELIVERY_SELECT });

/** The delivery's one-line text: the moment's heading, or who closed it. Never the task's own words. */
const lineOf = async (deps: NotifyDeps, row: DeliveryRow, change: "created" | "answered" | "dismissed"): Promise<string> => {
  const heading = momentHeading[row.notification.kind];
  if (change === "created") {
    return heading;
  }
  const by = row.notification.needsYouItem?.resolvedByMemberId ?? null;
  const verb = change === "answered" ? "Answered" : "Dismissed";
  if (by === null) {
    return `${heading}: resolved.`;
  }
  const member = await deps.db.member.findUnique({ where: { id: by }, select: { user: { select: { name: true } } } });
  return `${heading}: ${verb.toLowerCase()} by ${member?.user.name ?? "a member"}.`;
};

const urlOf = (deps: NotifyDeps, row: DeliveryRow): string => {
  const task = row.notification.task;
  return task === null ? deps.publicUrl.replace(/\/+$/, "") : taskUrlOf(deps.publicUrl, task.id);
};

/** The adapter contract's notification of one delivery, for the panel and the ticket (never mail: that has its own). */
const baseNotification = async (
  deps: NotifyDeps,
  row: DeliveryRow,
  change: "created" | "answered" | "dismissed",
  recipients: Notification["recipients"],
): Promise<Notification> => {
  const task = row.notification.task;
  const line = await lineOf(deps, row, change);
  return {
    organizationId: organizationIdSchema.parse(row.organizationId),
    memberIds: recipients.map((recipient) => recipient.memberId),
    title: momentHeading[row.notification.kind],
    body: line,
    url: urlOf(deps, row),
    idempotencyKey: row.idempotencyKey,
    kind: row.notification.kind,
    recipients,
    subject: task?.title ?? "",
    rendered: null,
    notificationId: notificationIdSchema.parse(row.notification.id),
    taskId: task === null ? null : taskIdSchema.parse(task.id),
    ticket:
      task?.ticket === null || task?.ticket === undefined
        ? null
        : { key: ticketKeySchema.parse(task.ticket.key) },
  };
};

const panelOutcome = async (deps: NotifyDeps, row: DeliveryRow, change: "created" | "answered" | "dismissed"): Promise<ChannelOutcome> => {
  const memberId = memberIdSchema.parse(row.notification.memberId);
  const notification = await baseNotification(deps, row, change, [{ memberId, email: null, trackerMention: null }]);
  const sent = await deps.channels.panel(organizationIdSchema.parse(row.organizationId)).send(notification);
  return sent.ok ? { outcome: "sent", providerMessageId: sent.value.providerMessageId } : { outcome: "failed", error: words(sent.error), retryable: retryable(sent.error) };
};

type SiblingRow = {
  readonly id: string;
  readonly notification: { readonly memberId: string; readonly member: { readonly user: { readonly email: string } } };
};

/** The ticket's other pending deliveries of this moment: they ride on the lead's one comment. */
const trackerSiblings = (deps: NotifyDeps, row: DeliveryRow, itemId: string, change: "created" | "answered" | "dismissed"): Promise<readonly SiblingRow[]> =>
  deps.db.notificationDelivery.findMany({
    where: {
      organizationId: row.organizationId,
      channel: "tracker",
      state: "pending",
      id: { not: row.id },
      idempotencyKey: { startsWith: `notify:${itemId}:${change}:`, endsWith: ":tracker" },
      notification: { needsYouItemId: itemId },
    },
    orderBy: { id: "asc" },
    select: { id: true, notification: { select: { memberId: true, member: { select: { user: { select: { email: true } } } } } } },
  });

/** The comment this task last posted for a new moment, when it's inside the window: the one to edit instead of posting again. */
const lastComment = async (deps: NotifyDeps, row: DeliveryRow, taskId: string): Promise<{ readonly providerMessageId: string; readonly postedAt: number } | null> => {
  const last = await deps.db.notificationDelivery.findFirst({
    where: {
      organizationId: row.organizationId,
      channel: "tracker",
      state: "sent",
      id: { not: row.id },
      providerMessageId: { not: null },
      idempotencyKey: { contains: ":created:" },
      notification: { taskId },
    },
    orderBy: { sentAt: "desc" },
    select: { providerMessageId: true },
  });
  if (last?.providerMessageId === null || last === null) {
    return null;
  }
  // The window runs from when the comment was posted, not from the latest edit into it.
  const posted = await deps.db.notificationDelivery.findFirst({
    where: { organizationId: row.organizationId, channel: "tracker", state: "sent", providerMessageId: last.providerMessageId },
    orderBy: { sentAt: "asc" },
    select: { sentAt: true },
  });
  return posted?.sentAt === null || posted === null ? null : { providerMessageId: last.providerMessageId, postedAt: posted.sentAt.getTime() };
};

type TrackerResult = { readonly outcome: ChannelOutcome; readonly siblings: readonly NotificationDeliveryId[] };

const trackerOutcome = async (deps: NotifyDeps, row: DeliveryRow, change: "created" | "answered" | "dismissed"): Promise<TrackerResult> => {
  const none = (outcome: ChannelOutcome): TrackerResult => ({ outcome, siblings: [] });
  const { task, needsYouItem: item } = row.notification;
  if (task === null || item === null || task.ticket === null || task.board === null) {
    return none({ outcome: "skipped", why: "no-ticket" });
  }
  // A new moment whose item is closed by now isn't worth a comment; the closed item's edit follows if one was posted.
  if (change === "created" && item.state !== "open") {
    return none({ outcome: "skipped", why: "closed" });
  }
  const organizationId = organizationIdSchema.parse(row.organizationId);
  const found = await deps.trackers.forConnection(organizationId, connectionIdSchema.parse(task.board.connectionId));
  if (!found.ok) {
    return none({ outcome: "failed", error: `the board's tracker isn't usable: ${found.reason}`, retryable: false });
  }
  const board: BoardRef = { externalId: task.board.externalId };
  const siblings = await trackerSiblings(deps, row, item.id, change);
  const people = [
    { memberId: memberIdSchema.parse(row.notification.memberId), email: row.notification.member.user.email },
    ...siblings.map((sibling) => ({ memberId: memberIdSchema.parse(sibling.notification.memberId), email: sibling.notification.member.user.email })),
  ];
  // One lookup per delivery for the whole audience; the match is kept nowhere (ADR 0050).
  const mentions = new Map<string, string>();
  if (found.value.tracker.capabilities.mentions) {
    const users = await found.value.tracker.findUsersByEmail(board, people.map((person) => person.email));
    if (users.ok) {
      for (const user of users.value) {
        mentions.set(user.email.toLowerCase(), user.mention);
      }
    } else {
      deps.logger.warn("notify.mentions-unavailable", { deliveryId: row.id, code: users.error.code });
    }
  }
  const recipients = people.map((person) => ({ memberId: person.memberId, email: null, trackerMention: mentions.get(person.email.toLowerCase()) ?? null }));
  const notification: Notification = {
    ...(await baseNotification(deps, row, change, recipients)),
    ticket: { key: ticketKeySchema.parse(task.ticket.key) },
  };
  const adapter = deps.channels.tracker({ organizationId, tracker: found.value.tracker, board });
  const siblingIds = siblings.map((sibling) => notificationDeliveryIdSchema.parse(sibling.id));

  const choice = trackerDelivery({
    change,
    lastComment: change === "created" ? await lastComment(deps, row, task.id) : null,
    itemComment: row.providerMessageId === null ? null : { providerMessageId: row.providerMessageId },
    now: deps.clock.now(),
    windowMinutes: deps.trackerCoalesceMinutes,
  });
  if (choice.mode === "edit") {
    const edited = await adapter.update(notification, choice.providerMessageId);
    if (edited.ok) {
      return { outcome: { outcome: "sent", providerMessageId: choice.providerMessageId }, siblings: siblingIds };
    }
    if (change !== "created") {
      // The comment is gone, or the tracker can't edit: nothing to say again.
      return edited.error.code === "not-found" || edited.error.code === "unsupported"
        ? { outcome: { outcome: "skipped", why: "nothing-to-edit" }, siblings: siblingIds }
        : { outcome: { outcome: "failed", error: words(edited.error), retryable: retryable(edited.error) }, siblings: siblingIds };
    }
    if (edited.error.code !== "not-found" && edited.error.code !== "unsupported") {
      return { outcome: { outcome: "failed", error: words(edited.error), retryable: retryable(edited.error) }, siblings: siblingIds };
    }
    // The last comment can't be edited (deleted, or not ours to edit): post a new one.
  }
  const sent = await adapter.send(notification);
  if (!sent.ok) {
    return { outcome: { outcome: "failed", error: words(sent.error), retryable: retryable(sent.error) }, siblings: siblingIds };
  }
  return { outcome: { outcome: "sent", providerMessageId: sent.value.providerMessageId }, siblings: siblingIds };
};

/** `notify.deliver`: one delivery, through its channel. */
export const notifyDeliverHandler =
  (deps: NotifyDeps): JobHandler<"notify.deliver"> =>
  async (context) => {
    const { organizationId, deliveryId } = context.payload;
    const row = await loadDelivery(deps.db, organizationId, deliveryId);
    if (row === null) {
      context.logger.warn("notify.delivery-missing", { deliveryId });
      return;
    }
    if (row.state !== "pending") {
      // A replayed job, or the lead of the ticket's comment already sent this one: nothing twice.
      return;
    }
    const change = deliveryChangeOf(row.idempotencyKey) ?? "created";
    let result: TrackerResult;
    try {
      switch (row.channel) {
        case "panel":
          result = { outcome: await panelOutcome(deps, row, change), siblings: [] };
          break;
        case "tracker":
          result = await trackerOutcome(deps, row, change);
          break;
        case "email":
          result = { outcome: await deps.email.deliver(row), siblings: [] };
          break;
        default:
          return row.channel satisfies never;
      }
    } catch (error) {
      // A bug or a dropped connection in an adapter: recorded as a failed attempt, never swallowed.
      result = { outcome: { outcome: "failed", error: `${error instanceof Error ? error.name : "error"} while delivering`, retryable: true }, siblings: [] };
    }
    const exhausted = context.retryCount >= queueSettings["notify.deliver"].retryLimit;
    const { outcome } = result;
    const willRetry = outcome.outcome === "failed" && outcome.retryable && !exhausted;
    for (const id of [deliveryId, ...result.siblings]) {
      const recorded = await recordDelivery(deps, toRecord(id, outcome, willRetry));
      if (!recorded.ok) {
        context.logger.warn("notify.record-failed", { deliveryId: id });
      }
    }
    context.logger.info("notify.delivered", {
      deliveryId,
      channel: row.channel,
      adapter: row.adapter,
      outcome: outcome.outcome,
      ...(outcome.outcome === "failed" ? { retry: willRetry } : {}),
    });
    if (willRetry) {
      throw new Error("the delivery failed and will be tried again");
    }
    if (row.channel === "tracker" && change === "created" && outcome.outcome === "sent") {
      await editIfClosedMeanwhile(deps, row);
    }
  };

const toRecord = (deliveryId: NotificationDeliveryId, outcome: ChannelOutcome, willRetry: boolean): DeliveryOutcome => {
  switch (outcome.outcome) {
    case "sent":
      return { deliveryId, outcome: "sent", providerMessageId: outcome.providerMessageId };
    case "skipped":
      return { deliveryId, outcome: "skipped", why: outcome.why };
    case "failed":
      // A wait keeps it pending for the queue's retry; none makes the failure final.
      return { deliveryId, outcome: "failed", error: outcome.error, retryAfterMs: willRetry ? 0 : null };
    default:
      return outcome satisfies never;
  }
};

/**
 * The item may have been answered while its comment was being posted, which the answer's fan-out
 * couldn't see (the comment had no ID yet). Run the closing fan-out again now that it has one.
 */
const editIfClosedMeanwhile = async (deps: NotifyDeps, row: DeliveryRow): Promise<void> => {
  const item = row.notification.needsYouItem;
  if (item === null) {
    return;
  }
  const now = await deps.db.needsYouItem.findUnique({ where: { id: item.id }, select: { state: true } });
  if (now === null || now.state === "open") {
    return;
  }
  await fanOutNotification(deps, { organizationId: organizationIdSchema.parse(row.organizationId), itemId: needsYouItemIdSchema.parse(item.id), change: now.state, emailDelaySeconds: deps.emailDelaySeconds });
};

