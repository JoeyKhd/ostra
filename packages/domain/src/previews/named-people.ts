import type { Tx } from "@ostra/db";
import { notificationDeliveryIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, ProjectId, TaskId } from "@ostra/protocol";

import { EMAIL_DELAY_SECONDS_DEFAULT, emailDueAt } from "../notifications/choices.ts";
import type { NotificationChannel } from "../notifications/choices.ts";
import type { Ports } from "../ports.ts";

// Telling a person they were named on a preview (milestone 8, F-142, ADR 0068): a member who sets a
// preview's level to named people tells each person newly named, in the panel and by mail (as the
// runner notices do, each person's choice wins), with a link to the preview's own page
// (`/previews/<the level's ID>`), where they watch it and nothing else of the task. Taking a name
// off tells no one. A notice is made once per naming: its key holds the naming's row, which a
// person named again gets anew. Never logged: the preview's label, a person's name.

/** The kind of a preview notice. */
export const PREVIEW_SHARED_KIND = "preview_shared";

/** A preview notice delivery's key: the kind, the naming's row, the change (always `created`), the member and the channel. */
export const previewShareNoticeKey = (input: { readonly namingId: string; readonly memberId: MemberId; readonly channel: NotificationChannel }): string =>
  `${PREVIEW_SHARED_KIND}:${input.namingId}:created:${input.memberId}:${input.channel}`;

/** The naming's row a preview notice delivery's key names (a `PreviewAccessMember`), or `null` for any other key. */
export const namingIdOfNoticeKey = (key: string): string | null => {
  const [kind, namingId] = key.split(":");
  return kind === PREVIEW_SHARED_KIND && namingId !== undefined && namingId !== "" ? namingId : null;
};

export type NamedPeopleNoticeDeps = Pick<Ports, "jobs" | "notices" | "clock"> & {
  /** `OSTRA_EMAIL_DELAY_SECONDS`, which the instance's saved delay overrides. */
  readonly emailDelaySeconds?: number;
};

/**
 * In the naming's transaction: a `preview_shared` notification for each person newly named (their
 * naming's row just made), but never for the member who named them, with its panel delivery and its
 * mail (unless they turned that off), each queued for `notify.deliver`. Answers how many were told.
 */
export const notifyNamedPeopleInTx = async (
  deps: NamedPeopleNoticeDeps,
  tx: Tx,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly taskId: TaskId;
    readonly by: MemberId;
    /** The rows of the people named just now: each naming's row, and its person. */
    readonly named: readonly { readonly namingId: string; readonly memberId: MemberId }[];
  },
): Promise<number> => {
  const told = input.named.filter((naming) => naming.memberId !== input.by);
  if (told.length === 0) {
    return 0;
  }
  const { organizationId } = input;
  const memberIds = told.map((naming) => naming.memberId);
  const now = deps.clock.now();
  // One query at a time: a transaction's connection runs them in turn anyway.
  const preferences = await tx.notificationPreference.findMany({ where: { memberId: { in: memberIds }, kind: PREVIEW_SHARED_KIND, channel: "email" }, select: { memberId: true, enabled: true } });
  const saved = await tx.instanceSetting.findUnique({ where: { id: "instance" }, select: { emailDelaySeconds: true } });
  const email = await tx.emailSettings.findUnique({ where: { id: "instance" }, select: { provider: true } });
  const emailProvider = email?.provider ?? "off";
  const delaySeconds = saved?.emailDelaySeconds ?? deps.emailDelaySeconds ?? EMAIL_DELAY_SECONDS_DEFAULT;
  for (const naming of told) {
    const notification = await tx.notification.create({
      data: { organizationId, memberId: naming.memberId, projectId: input.projectId, taskId: input.taskId, kind: PREVIEW_SHARED_KIND, state: "open" },
      select: { id: true },
    });
    // Mail is on by default: a person named on a preview may not be in the panel. A saved choice wins.
    const wantsMail = preferences.find((row) => row.memberId === naming.memberId)?.enabled ?? true;
    const channels: readonly NotificationChannel[] = wantsMail ? ["panel", "email"] : ["panel"];
    for (const channel of channels) {
      const dueAt = channel === "email" ? emailDueAt(now, delaySeconds) : now;
      const delivery = await tx.notificationDelivery.create({
        data: {
          organizationId,
          notificationId: notification.id,
          channel,
          adapter: channel === "panel" ? "panel" : emailProvider === "off" ? "email" : emailProvider,
          idempotencyKey: previewShareNoticeKey({ namingId: naming.namingId, memberId: naming.memberId, channel }),
          dueAt: new Date(dueAt),
        },
        select: { id: true },
      });
      const wait = Math.max(0, dueAt - now);
      await deps.jobs.enqueueInTx(tx, "notify.deliver", { organizationId, deliveryId: notificationDeliveryIdSchema.parse(delivery.id) }, wait === 0 ? undefined : { startAfterMs: wait });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: naming.memberId });
  }
  return told.length;
};
