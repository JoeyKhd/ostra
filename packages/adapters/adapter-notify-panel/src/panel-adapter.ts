import { adapterError, NotificationAdapter, ok } from "@ostra/adapter-sdk";
import type { AdapterContext, AdapterResult, HealthReport, Notification, NotificationCapabilities, SendResult } from "@ostra/adapter-sdk";
import { notificationIdSchema } from "@ostra/protocol";
import type { NotificationId } from "@ostra/protocol";

import type { PanelNotificationRows } from "./panel-rows.ts";

// The panel channel (ADR 0050): the "Needs you" page and the sidebar's count. Always on, and it
// can't be turned off. It keeps nothing of its own. Core writes a member's `Notification` row when
// it fans an item out, and this adapter's delivery is that row becoming delivered, so the row is
// what the member sees, unread. An answer or a dismissal edits it in place (`update`), which keeps
// the row and moves its state.
//
// A notification for this channel is for one row, so for one member: `notificationId` names the
// row, and a recipient who isn't that row's member is reported as refused, never delivered to.
// Logs carry IDs, never a title, a body or an address.

export type PanelNotificationAdapterOptions = { readonly rows: PanelNotificationRows };

export class PanelNotificationAdapter extends NotificationAdapter {
  readonly name = "panel";
  readonly capabilities: NotificationCapabilities = { channels: ["panel"], edits: true };

  readonly #rows: PanelNotificationRows;

  constructor(options: PanelNotificationAdapterOptions, context?: AdapterContext) {
    super(context);
    this.#rows = options.rows;
  }

  health(): Promise<HealthReport> {
    // The rows' database has its own health check; this channel holds no state of its own.
    return Promise.resolve({ status: "ok" });
  }

  async send(notification: Notification): Promise<AdapterResult<SendResult>> {
    const id = notification.notificationId;
    if (id === undefined || id === null) {
      return adapterError("invalid-input", "a panel notification needs the row it delivers");
    }
    let delivery;
    try {
      delivery = await this.#rows.markDelivered({ organizationId: notification.organizationId, notificationId: id }, this.plumbing.clock.now());
    } catch {
      this.plumbing.logger.warn("panel.deliver_failed", { organizationId: notification.organizationId, notificationId: id });
      return adapterError("unavailable", "the panel's rows could not be written");
    }
    if (delivery === undefined) {
      return adapterError("not-found", "the panel has no such notification");
    }
    const refused = notification.recipients
      .filter((recipient) => recipient.memberId !== delivery.memberId)
      .map((recipient) => ({ memberId: recipient.memberId, reason: "the notification belongs to another member" }));
    this.plumbing.logger.info("panel.delivered", {
      organizationId: notification.organizationId,
      notificationId: id,
      kind: notification.kind,
      first: delivery.firstDelivery,
      refused: refused.length,
    });
    return ok({ providerMessageId: id, refused });
  }

  override async update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    const parsed = notificationIdSchema.safeParse(providerMessageId);
    if (!parsed.success) {
      return adapterError("invalid-input", "the panel's notification IDs are the row's ID");
    }
    const id: NotificationId = parsed.data;
    if (notification.notificationId !== undefined && notification.notificationId !== null && notification.notificationId !== id) {
      return adapterError("invalid-input", "the notification names another row than the ID to update");
    }
    const state = notification.state ?? "open";
    let found: boolean;
    try {
      found = await this.#rows.updateState(
        { organizationId: notification.organizationId, notificationId: id },
        { state, line: notification.body },
      );
    } catch {
      this.plumbing.logger.warn("panel.update_failed", { organizationId: notification.organizationId, notificationId: id });
      return adapterError("unavailable", "the panel's rows could not be written");
    }
    if (!found) {
      return adapterError("not-found", "the panel has no such notification");
    }
    this.plumbing.logger.info("panel.updated", { organizationId: notification.organizationId, notificationId: id, state });
    return ok(undefined);
  }
}
