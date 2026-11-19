import type { ExecutorKind, MemberId, NotificationId, OrganizationId, RunnerId, TaskId } from "@ostra/protocol";

import { createPlumbing, defaultAdapterContext } from "../common/context.ts";
import type { AdapterContext, Plumbing } from "../common/context.ts";
import { adapterError } from "../common/result.ts";
import type { AdapterError, AdapterResult, Err, HealthReport } from "../common/result.ts";
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

/**
 * Milestone 4 (ADR 0055): the budget notices, at 80% and at 100% of a budget. They are moments,
 * like milestone 3's: the panel and email, with the delay and the members' choices.
 */
export const budgetNotificationKinds = ["budget_warning", "budget_reached"] as const;
export type BudgetNotificationKind = (typeof budgetNotificationKinds)[number];

/**
 * Milestone 4 (ADR 0053): the account mails, for a person who may not be able to sign in yet. Email
 * only, at once, with no delay and no choice to turn them off, and each carries a bearer link.
 */
export const accountNotificationKinds = ["invitation", "email_verification", "password_reset"] as const;
export type AccountNotificationKind = (typeof accountNotificationKinds)[number];

/**
 * Milestone 5 (F-091): the runner notices, for the organization's admins. A runner joined a pool,
 * or joined one that requires approval and waits for it. Moments, in the panel and by mail; the
 * tracker channel refuses them, since a runner is no ticket's business.
 */
export const runnerNotificationKinds = ["runner_joined", "runner_awaiting_approval"] as const;
export type RunnerNotificationKind = (typeof runnerNotificationKinds)[number];

/** Whether a kind is a runner notice, which only the panel and email channels deliver. */
export const isRunnerNotice = (kind: string): kind is RunnerNotificationKind => runnerNotificationKinds.some((candidate) => candidate === kind);

/**
 * What a runner notice is about (F-091): the runner's name, its pool, its executor, the join
 * token's label and the runner's page. Never the join token, the runner's key or any credential:
 * the type has no field for one.
 */
export type RunnerNoticeSubject = {
  readonly runnerId: RunnerId;
  /** The name the runner gave itself. Untrusted text: data, never logged. */
  readonly runnerName: string;
  readonly poolName: string;
  readonly executor: ExecutorKind;
  /** The label of the join token it used; `null` for a token without one. Never the token. */
  readonly tokenLabel: string | null;
  /** The runner's page in the panel. */
  readonly url: string;
};

/** A moment's kinds: milestone 3's, the budget notices and the runner notices. */
export type MomentNotificationKind = NotificationKind | BudgetNotificationKind | RunnerNotificationKind;

/**
 * Milestone 4: what a notification is. A `moment` is a needs-you moment or a budget notice for
 * members, on any channel; an `account` mail is one address's invitation, verification or reset,
 * on an email channel only. The panel and tracker channels refuse it as `unsupported`.
 */
export const notificationCategories = ["moment", "account"] as const;
export type NotificationCategory = (typeof notificationCategories)[number];

/** One recipient, with what each channel needs to reach them. */
export type NotificationRecipient = {
  readonly memberId: MemberId;
  /** The member's address, for email; `null` when they have none. Never logged. */
  readonly email: string | null;
  /** The markdown that notifies them on the tracker, from `findUsersByEmail`; `null` when the tracker has no match. */
  readonly trackerMention: string | null;
};

/** An account mail's one recipient: an address, and the member it belongs to when there is one yet. */
export type AccountRecipient = {
  /** Never logged. */
  readonly email: string;
  /** `null` for an invited person who has no account in the organization yet. */
  readonly memberId: MemberId | null;
};

/**
 * Where the moment stands, for the channels that edit (`update`): `open` while it waits for an
 * answer, `answered` or `dismissed` after. Absent means `open`.
 */
export type NotificationMomentState = "open" | "answered" | "dismissed";

/** An email's three parts, from the domain's pure renderers (ADR 0050). Never logged. */
export type RenderedEmail = { readonly subject: string; readonly html: string; readonly text: string };

type NotificationFields = {
  readonly organizationId: OrganizationId;
  readonly title: string;
  readonly body: string;
  /** The panel's page it's about; for an account mail, its bearer link, never logged. */
  readonly url: string;
  /** Sends at most once per key (ADR 0011). */
  readonly idempotencyKey: string;
  /** The task's title, or the test's; for an account mail, the organization's name. Untrusted text: data, never logged. */
  readonly subject: string;
};

/** A needs-you moment or a budget notice, for members (milestone 3, ADR 0050). */
export type MomentNotification = NotificationFields & {
  /** Milestone 4. Absent: a moment, as every milestone 3 notification is. */
  readonly category?: "moment";
  readonly memberIds: readonly MemberId[];
  // ---- milestone 3 (ADR 0050) ----
  /** The moment. */
  readonly kind: MomentNotificationKind;
  /** Who it's for, with their address and mention. */
  readonly recipients: readonly NotificationRecipient[];
  /** The email's parts, for an email channel; `null` for the others. */
  readonly rendered: RenderedEmail | null;
  /** The panel's row it delivers, when there is one (the panel channel). */
  readonly notificationId?: NotificationId | null;
  /** The task it's about; `null` for a test. */
  readonly taskId?: TaskId | null;
  /** The task's ticket, for the tracker channel; `null` for a prompt task or a test. */
  readonly ticket?: TicketRef | null;
  /** Where the moment stands (ticket 11): the panel's row and the ticket's comment follow it on `update`. Absent: `open`. */
  readonly state?: NotificationMomentState;
  /** Milestone 5: the runner a runner notice is about. Absent for every other kind. */
  readonly runner?: RunnerNoticeSubject;
};

/**
 * Milestone 4 (ADR 0053): an invitation, a verification or a reset, to one address. Core sends it
 * at once, past the delay and the members' choices; the channel's `send` is the same call. Its
 * `url` is a bearer link: in both the HTML and the text part, and never in a log line, an error
 * or anything `send` returns.
 */
export type AccountNotification = NotificationFields & {
  readonly category: "account";
  readonly kind: AccountNotificationKind;
  readonly to: AccountRecipient;
  readonly rendered: RenderedEmail;
};

export type Notification = MomentNotification | AccountNotification;

/** One address an email channel mails: a moment's member, or an account mail's person, who may be no member yet. */
export type EmailRecipient = { readonly memberId: MemberId | null; readonly email: string | null };

/** Who an email channel mails for a notification: a moment's recipients, or an account mail's one address. */
export const emailRecipients = (notification: Notification): readonly EmailRecipient[] =>
  notification.category === "account" ? [notification.to] : notification.recipients;

/** The part of a per-recipient key (a message ID, an idempotency key) that names the recipient. */
export const emailRecipientKey = (recipient: EmailRecipient): string => recipient.memberId ?? "account-mail";

/** The typed refusal of a channel that only sends moments, the panel's and the tracker's: `unsupported`. */
export const refuseAccountMail = (channel: string): Err<AdapterError> =>
  adapterError("unsupported", `the ${channel} channel doesn't send account mails: they go by email`);

/** The typed refusal of the tracker channel for a runner notice (F-091): `unsupported`. */
export const refuseRunnerNotice = (channel: string): Err<AdapterError> =>
  adapterError("unsupported", `the ${channel} channel doesn't send runner notices: they go to the panel and by mail`);

/** A recipient the channel refused, without failing the others. `reason` is words, never a vendor's body. */
export type RefusedRecipient = {
  /** `null` for an account mail's address that belongs to no member yet. */
  readonly memberId: MemberId | null;
  readonly reason: string;
};

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
