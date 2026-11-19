import { PanelNotificationAdapter } from "@ostra/adapter-notify-panel";
import type { PanelNotificationRows } from "@ostra/adapter-notify-panel";
import { TrackerNotificationAdapter } from "@ostra/adapter-notify-tracker";
import type { AdapterContext } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { memberIdSchema } from "@ostra/protocol";

import type { NotificationChannels } from "./deliver.ts";

// The channels' adapters, built per delivery from the registry (ADR 0025, ADR 0050). The panel's
// rows are the `Notification` table: fan-out wrote them, so "delivering" to the panel is the row
// becoming delivered, and an answer moves its state. The ticket's channel wraps the board's own
// tracker adapter, so it works for any tracker that can comment (adapter parity).

/** The panel adapter's ports on the database. A row of another organization is never found. */
export const postgresPanelRows = (db: Db): PanelNotificationRows => ({
  markDelivered: async (ref) => {
    const row = await db.notification.findFirst({
      where: { id: ref.notificationId, organizationId: ref.organizationId },
      select: { memberId: true, deliveries: { where: { channel: "panel", state: "sent" }, select: { id: true }, take: 1 } },
    });
    return row === null ? undefined : { memberId: memberIdSchema.parse(row.memberId), firstDelivery: row.deliveries.length === 0 };
  },
  updateState: async (ref, update) => {
    const result = await db.notification.updateMany({
      where: { id: ref.notificationId, organizationId: ref.organizationId },
      data: { state: update.state },
    });
    return result.count > 0;
  },
});

export const createNotificationChannels = (db: Db, context: AdapterContext): NotificationChannels => {
  const rows = postgresPanelRows(db);
  return {
    panel: () => new PanelNotificationAdapter({ rows }, context),
    tracker: ({ tracker, board }) => new TrackerNotificationAdapter({ tracker, board }, context),
  };
};
