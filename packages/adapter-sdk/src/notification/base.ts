import type { MemberId, NotificationId, OrganizationId, TaskId } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError } from "../common/result.ts";
import type { AdapterResult, HealthReport } from "../common/result.ts";
import type { TicketRef } from "../tracker/base.ts";
import type { NotificationCapabilities } from "./capabilities.ts";

// The notification kind (ADR 0025, ADR 0050): the panel, the ticket and email in milestone 3,
// Slack later. A notification is one needs-you moment for its recipients on one channel; core's
// fan-out decides who and where (ticket 20), and each adapter only delivers.

/**
 * The moments a member is notified of (ADR 0050): the needs-you reasons milestone 3 notifies, and
 * a test mail. The database's `NotificationKind` holds the same values.
 */
export const notificationKinds = [
  "approval",
  "question",
  "plan",
  "pr_ready",
  "no_changes",
  "stalled",
  "spend_cap",
  "crashed",
  "setup_failed",
  "ticket_closed",
  "test",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

/** One recipient, with what each channel needs to reach them. */
export type NotificationRecipient = {
  readonly memberId: MemberId;
  /** The member's address, for email; `null` when they have none. Never logged. */
  readonly email: string | null;
  /** The markdown that notifies them on the tracker, from `findUsersByEmail`; `null` when the tracker has no match. */
  readonly trackerMention: string | null;
};

/** An email's three parts, from the domain's pure renderers (ADR 0050). Never logged. */
export type RenderedEmail = { readonly subject: string; readonly html: string; readonly text: string };

export type Notification = {
  readonly organizationId: OrganizationId;
  readonly memberIds: readonly MemberId[];
  readonly title: string;
  readonly body: string;
  /** The panel's page it's about. */
  readonly url: string;
  /** Sends at most once per key (ADR 0011). */
  readonly idempotencyKey: string;
  // ---- milestone 3 (ADR 0050) ----
  /** The moment. */
  readonly kind: NotificationKind;
  /** Who it's for, with their address and mention. */
  readonly recipients: readonly NotificationRecipient[];
  /** The task's title, or the test's. Untrusted text when it's a task's: data, never logged. */
  readonly subject: string;
  /** The email's parts, for an email channel; `null` for the others. */
  readonly rendered: RenderedEmail | null;
  /** The panel's row it delivers, when there is one (the panel channel). */
  readonly notificationId?: NotificationId | null;
  /** The task it's about; `null` for a test. */
  readonly taskId?: TaskId | null;
  /** The task's ticket, for the tracker channel; `null` for a prompt task or a test. */
  readonly ticket?: TicketRef | null;
};

/** A recipient the channel refused, without failing the others. `reason` is words, never a vendor's body. */
export type RefusedRecipient = { readonly memberId: MemberId; readonly reason: string };

/** What a send did: the provider's ID of what it sent (for `update`), and who it couldn't reach. */
export type SendResult = {
  /** `null` when the channel keeps no ID of its own (it sent nothing it can edit). */
  readonly providerMessageId: string | null;
  readonly refused: readonly RefusedRecipient[];
};

export abstract class NotificationAdapter {
  readonly kind = "notification" as const;
  abstract readonly name: string;
  abstract readonly capabilities: NotificationCapabilities;

  readonly #context: AdapterContext;
  #plumbing: Plumbing | undefined;

  constructor(context: AdapterContext = defaultAdapterContext) {
    this.#context = context;
  }

  /** Retries, rate budgets, idempotency and the logger, shared by every adapter (ADR 0025). */
  protected get plumbing(): Plumbing {
    this.#plumbing ??= createPlumbing(this.#context, { kind: this.kind, name: this.name });
    return this.#plumbing;
  }

  abstract health(): Promise<HealthReport>;

  /**
   * Delivers one notification on this adapter's channel, at most once per `idempotencyKey`: a
   * second send of the key answers what the first did. A recipient the channel refuses is in
   * `refused`; the others still get it. A provider's rate limit answers `rate-limited`.
   */
  abstract send(notification: Notification): Promise<AdapterResult<SendResult>>;

  /**
   * Milestone 3: edits a sent notification in place, where the channel can (capability `edits`):
   * the tracker's comment for a coalesced moment or an answered approval (ADR 0050). Without it,
   * `unsupported`.
   */
  update(notification: Notification, providerMessageId: string): Promise<AdapterResult<void>> {
    this.plumbing.logger.debug("update is not supported", { kind: notification.kind, idLength: providerMessageId.length });
    return Promise.resolve(adapterError("unsupported", `${this.name} can't edit a sent notification`));
  }
}
