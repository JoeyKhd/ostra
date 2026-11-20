import type { DbEnum, Tx } from "@ostra/db";
import { memberIdSchema, notificationDeliveryIdSchema, notificationIdSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { MemberId, NeedsYouItemId, NotificationDeliveryId, NotificationId, OrganizationId, ProjectId } from "@ostra/protocol";

import { channelsFor, deliveryKey, EMAIL_DELAY_SECONDS_DEFAULT, emailDueAt, isMomentKind } from "../notifications/choices.ts";
import type { NotificationChannel, NotificationChoice } from "../notifications/choices.ts";
import { resolveAudience } from "../notifications/choices.ts";
import type { UseCaseResult } from "./common.ts";
import type { DeliverySkipReason, M3Deps } from "./m3-signatures.ts";
import { notificationKindOfReason } from "./needs-you-items.ts";
import type { ItemChange } from "./needs-you-items.ts";

// Notifications (F-036, F-115, ADR 0050; ticket 20). Fan-out writes before anything is sent: one
// notification per member of an item's audience and one delivery per channel the member wants,
// each with a key of the item, the change, the member and the channel, so a replayed job writes
// nothing twice. Then `notify.deliver` jobs send each delivery on its own, in the same transaction
// that wrote them (ADR 0011). Logs and error words carry IDs, never a mail's body or an address.

// ---------- who can open the project ----------

/** The members of the organization who can open the project now: everyone on an open project, the admins and the listed on a restricted one. */
export const projectMemberIdsInTx = async (
  tx: Tx,
  organizationId: string,
  projectId: string,
  access: DbEnum.ProjectAccess,
): Promise<readonly MemberId[]> => {
  const members = await tx.member.findMany({ where: { organizationId }, select: { id: true, role: true }, orderBy: { id: "asc" } });
  if (access === "open") {
    return members.map((member) => memberIdSchema.parse(member.id));
  }
  const listed = new Set((await tx.projectMember.findMany({ where: { projectId, organizationId }, select: { memberId: true } })).map((row) => row.memberId));
  return members.filter((member) => member.role === "admin" || listed.has(member.id)).map((member) => memberIdSchema.parse(member.id));
};

/** The adapter's registered name for a channel's deliveries: the panel's, the tracker's, or the provider's. */
const adapterNameOf = (channel: NotificationChannel, provider: DbEnum.EmailProvider): string => {
  switch (channel) {
    case "panel":
      return "panel";
    case "tracker":
      return "tracker";
    case "email":
      return provider === "off" ? "email" : provider;
    default:
      return channel satisfies never;
  }
};

/** How long a mail waits: the instance's own saved delay, else the setting's. */
const emailDelaySecondsInTx = async (tx: Tx, fallback: number | undefined): Promise<number> => {
  const saved = await tx.instanceSetting.findUnique({ where: { id: "instance" }, select: { emailDelaySeconds: true } });
  return saved?.emailDelaySeconds ?? fallback ?? EMAIL_DELAY_SECONDS_DEFAULT;
};

// ---------- the fan-out ----------

export type FanOutInput = {
  /** The job's organization: an item of another organization is `not-found`, never notified. */
  readonly organizationId?: OrganizationId;
  readonly itemId: NeedsYouItemId;
  readonly change: ItemChange;
  /** `OSTRA_EMAIL_DELAY_SECONDS`, which the instance's saved delay overrides. */
  readonly emailDelaySeconds?: number;
};

export type FanOutResult = UseCaseResult<{ readonly notifications: number; readonly deliveries: number }, "not-found">;

const nothing: FanOutResult = { ok: true, notifications: 0, deliveries: 0 };

/**
 * Resolves an item's audience to members and writes what each is owed (F-036). `created`: a
 * notification per member and a delivery per wanted channel (panel always, the ticket when the task
 * has one, mail as the member chose), each enqueued as a `notify.deliver` job; the mail waits the
 * email delay. `answered` and `dismissed`: the members' notifications close, and the ticket's
 * comment is edited. The counts are what this run wrote: a replay writes and counts none.
 */
export const fanOutNotification = async (deps: M3Deps, input: FanOutInput): Promise<FanOutResult> =>
  deps.db.$transaction(async (tx): Promise<FanOutResult> => {
    const item = await tx.needsYouItem.findUnique({
      where: { id: input.itemId },
      select: { id: true, organizationId: true, projectId: true, taskId: true, reason: true, audience: true, state: true },
    });
    if (item === null || (input.organizationId !== undefined && input.organizationId !== item.organizationId)) {
      return { ok: false, error: "not-found", message: "No such item" };
    }
    const itemTask = await tx.task.findUnique({ where: { id: item.taskId }, select: { kind: true } });
    const kind = notificationKindOfReason(item.reason, itemTask?.kind);
    if (kind === null) {
      return nothing;
    }
    // The organization admins' items (F-135) notify nobody here: needs-you shows them.
    const audience = item.audience;
    if (audience === "organization_admins") {
      return nothing;
    }
    const organizationId = organizationIdSchema.parse(item.organizationId);
    const projectId = projectIdSchema.parse(item.projectId);
    const task = await tx.task.findUniqueOrThrow({ where: { id: item.taskId }, select: { driverMemberId: true, ticketId: true, boardId: true } });
    const project = await tx.project.findUniqueOrThrow({ where: { id: item.projectId }, select: { access: true } });
    const projectMembers = await projectMemberIdsInTx(tx, item.organizationId, item.projectId, project.access);
    const recipients = resolveAudience({
      audience,
      kind,
      driverMemberId: task.driverMemberId === null ? null : memberIdSchema.parse(task.driverMemberId),
      projectMembers,
    });
    if (recipients.length === 0) {
      return nothing;
    }
    const memberIds = recipients.map((recipient) => recipient.memberId);
    const taskHasTicket = task.ticketId !== null && task.boardId !== null;
    const now = deps.clock.now();

    if (input.change !== "created") {
      return closeNotificationsInTx(deps, tx, { organizationId, projectId, itemId: item.id, change: input.change, memberIds, now });
    }

    const [emailSettings, preferences, delaySeconds] = await Promise.all([
      tx.emailSettings.findUnique({ where: { id: "instance" }, select: { provider: true } }),
      tx.notificationPreference.findMany({ where: { memberId: { in: [...memberIds] }, kind }, select: { memberId: true, kind: true, channel: true, enabled: true } }),
      emailDelaySecondsInTx(tx, input.emailDelaySeconds),
    ]);
    const provider = emailSettings?.provider ?? "off";

    const createdNotifications = await tx.notification.createManyAndReturn({
      data: memberIds.map((memberId) => ({
        organizationId,
        memberId,
        projectId,
        taskId: item.taskId,
        needsYouItemId: item.id,
        kind,
        state: item.state,
      })),
      skipDuplicates: true,
      select: { id: true, memberId: true },
    });
    const notifications = await tx.notification.findMany({ where: { needsYouItemId: item.id, memberId: { in: [...memberIds] } }, select: { id: true, memberId: true } });

    // An item already closed by the time its fan-out runs notifies the panel only: nothing outside needs it.
    const deliveries = notifications.flatMap((notification) => {
      const choices: readonly NotificationChoice[] = preferences.flatMap((row) =>
        row.memberId === notification.memberId && isMomentKind(row.kind) ? [{ ...row, kind: row.kind }] : [],
      );
      // Mail is decided when it's due (`off`, no address, read), so its delivery is written either way.
      const channels = channelsFor({ kind, choices, taskHasTicket, emailOn: true, memberHasEmail: true });
      return channels
        .filter((channel) => item.state === "open" || channel === "panel")
        .map((channel) => ({
          organizationId,
          notificationId: notification.id,
          channel,
          adapter: adapterNameOf(channel, provider),
          idempotencyKey: deliveryKey({ itemId: item.id, change: "created", memberId: memberIdSchema.parse(notification.memberId), channel }),
          dueAt: new Date(channel === "email" ? emailDueAt(now, delaySeconds) : now),
        }));
    });
    const createdDeliveries = await tx.notificationDelivery.createManyAndReturn({
      data: deliveries,
      skipDuplicates: true,
      select: { id: true, channel: true, dueAt: true },
    });
    await enqueueDeliveriesInTx(deps, tx, organizationId, createdDeliveries, now);

    for (const notification of createdNotifications) {
      await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberIdSchema.parse(notification.memberId) });
    }
    return { ok: true, notifications: createdNotifications.length, deliveries: createdDeliveries.length };
  });

/**
 * Enqueues each new delivery's job. The ticket's comment is one per moment: only the lead of its
 * deliveries (the lowest ID) is enqueued, and sending it records every sibling's, so the ticket
 * gets one comment that mentions every recipient, never one each.
 */
const enqueueDeliveriesInTx = async (
  deps: M3Deps,
  tx: Tx,
  organizationId: OrganizationId,
  created: readonly { readonly id: string; readonly channel: DbEnum.NotificationChannel; readonly dueAt: Date }[],
  now: number,
): Promise<void> => {
  const trackerLead = created
    .filter((delivery) => delivery.channel === "tracker")
    .map((delivery) => delivery.id)
    .sort()[0];
  for (const delivery of created) {
    if (delivery.channel === "tracker" && delivery.id !== trackerLead) {
      continue;
    }
    const wait = Math.max(0, delivery.dueAt.getTime() - now);
    await deps.jobs.enqueueInTx(
      tx,
      "notify.deliver",
      { organizationId, deliveryId: notificationDeliveryIdSchema.parse(delivery.id) },
      wait === 0 ? undefined : { startAfterMs: wait },
    );
  }
};

/** An answer or a dismissal: the members' notifications close, and each sent ticket comment is edited to say so. */
const closeNotificationsInTx = async (
  deps: M3Deps,
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly itemId: string;
    readonly change: "answered" | "dismissed";
    readonly memberIds: readonly MemberId[];
    readonly now: number;
  },
): Promise<FanOutResult> => {
  const closing = await tx.notification.findMany({ where: { needsYouItemId: input.itemId, state: "open" }, select: { id: true, memberId: true } });
  await tx.notification.updateMany({ where: { id: { in: closing.map((row) => row.id) }, state: "open" }, data: { state: input.change } });
  const all = await tx.notification.findMany({ where: { needsYouItemId: input.itemId }, select: { id: true, memberId: true } });

  // Edit the ticket comment of each notification whose comment was sent: its delivery's provider ID says which.
  const sent = await tx.notificationDelivery.findMany({
    where: { notificationId: { in: all.map((row) => row.id) }, channel: "tracker", state: "sent", providerMessageId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { notificationId: true, providerMessageId: true },
  });
  const memberOf = new Map(all.map((row) => [row.id, row.memberId]));
  const seen = new Set<string>();
  const edits = sent.flatMap((delivery) => {
    const memberId = memberOf.get(delivery.notificationId);
    if (memberId === undefined || seen.has(delivery.notificationId)) {
      return [];
    }
    seen.add(delivery.notificationId);
    return [
      {
        organizationId: input.organizationId,
        notificationId: delivery.notificationId,
        channel: "tracker" as const,
        adapter: "tracker",
        idempotencyKey: deliveryKey({ itemId: input.itemId, change: input.change, memberId: memberIdSchema.parse(memberId), channel: "tracker" }),
        providerMessageId: delivery.providerMessageId,
        dueAt: new Date(input.now),
      },
    ];
  });
  const createdEdits = await tx.notificationDelivery.createManyAndReturn({ data: edits, skipDuplicates: true, select: { id: true, channel: true, dueAt: true } });
  await enqueueDeliveriesInTx(deps, tx, input.organizationId, createdEdits, input.now);
  for (const row of closing) {
    await deps.notices.emitInTx(tx, { organizationId: input.organizationId, projectId: null, entity: "member", entityId: memberIdSchema.parse(row.memberId) });
  }
  return { ok: true, notifications: closing.length, deliveries: createdEdits.length };
};

// ---------- a delivery's outcome ----------

const SKIP_WORDS: Readonly<Record<DeliverySkipReason, string>> = {
  read: "The member read it in the panel first.",
  closed: "The item was no longer open.",
  "channel-off": "The member turned this channel off.",
  "mail-off": "Mail is off.",
  "no-address": "The member has no address.",
  "no-ticket": "The task has no ticket.",
  "nothing-to-edit": "There was no comment to edit.",
};

/** What a skipped delivery says on the notification, in words. */
export const skipWords = (why: DeliverySkipReason): string => SKIP_WORDS[why];

const ERROR_MAX = 500;

export type DeliveryOutcome =
  | { readonly deliveryId: NotificationDeliveryId; readonly outcome: "sent"; readonly providerMessageId: string | null }
  | { readonly deliveryId: NotificationDeliveryId; readonly outcome: "skipped"; readonly why: DeliverySkipReason }
  | { readonly deliveryId: NotificationDeliveryId; readonly outcome: "failed"; readonly error: string; readonly retryAfterMs: number | null };

/**
 * Records what one delivery did (ticket 20). `sent` keeps the provider's ID, which an edit needs;
 * `skipped` says why in words; `failed` with a wait stays pending to retry, and `failed` with none
 * is final. Each attempt counts.
 */
export const recordDelivery = async (
  deps: Pick<M3Deps, "db" | "clock" | "notices">,
  input: DeliveryOutcome,
): Promise<UseCaseResult<{ readonly deliveryId: NotificationDeliveryId }, "not-found">> =>
  deps.db.$transaction(async (tx) => {
    const delivery = await tx.notificationDelivery.findUnique({
      where: { id: input.deliveryId },
      select: { id: true, organizationId: true, channel: true, adapter: true, notification: { select: { memberId: true, kind: true } } },
    });
    if (delivery === null) {
      return { ok: false, error: "not-found", message: "No such delivery" } as const;
    }
    const at = new Date(deps.clock.now());
    switch (input.outcome) {
      case "sent":
        await tx.notificationDelivery.update({
          where: { id: delivery.id },
          data: { state: "sent", sentAt: at, error: null, attempts: { increment: 1 }, ...(input.providerMessageId === null ? {} : { providerMessageId: input.providerMessageId }) },
        });
        break;
      case "skipped":
        await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { state: "skipped", error: skipWords(input.why) } });
        break;
      case "failed":
        await tx.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            state: input.retryAfterMs === null ? "failed" : "pending",
            error: input.error.slice(0, ERROR_MAX),
            attempts: { increment: 1 },
            ...(input.retryAfterMs === null ? {} : { dueAt: new Date(at.getTime() + input.retryAfterMs) }),
          },
        });
        break;
      default:
        input satisfies never;
    }
    await deps.notices.emitInTx(tx, {
      organizationId: organizationIdSchema.parse(delivery.organizationId),
      projectId: null,
      entity: "member",
      entityId: memberIdSchema.parse(delivery.notification.memberId),
    });
    return { ok: true, deliveryId: input.deliveryId } as const;
  });

// ---------- reading ----------

/** The member marks their own notifications read in the panel: a mail still waiting for each is then skipped. */
export const markNotificationRead = async (
  deps: Pick<M3Deps, "db" | "clock" | "notices">,
  scope: { readonly organizationId: OrganizationId; readonly memberId: MemberId },
  input: { readonly notificationIds: readonly NotificationId[] },
): Promise<{ readonly ok: true; readonly marked: number }> => {
  const marked = await deps.db.$transaction(async (tx) => {
    const result = await tx.notification.updateMany({
      where: { id: { in: input.notificationIds.map((id) => notificationIdSchema.parse(id)) }, memberId: scope.memberId, organizationId: scope.organizationId, readAt: null },
      data: { readAt: new Date(deps.clock.now()) },
    });
    if (result.count > 0) {
      await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId: null, entity: "member", entityId: scope.memberId });
    }
    return result.count;
  });
  return { ok: true, marked };
};
