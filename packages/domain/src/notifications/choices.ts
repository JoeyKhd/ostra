import { notificationKinds, teamNotificationKinds } from "@ostra/adapter-sdk";
import type { NotificationKind, TeamNotificationKind } from "@ostra/adapter-sdk";
import type { MemberId } from "@ostra/protocol";

// Who a notification goes to, on which channels, and when (ADR 0050, F-036, F-115). Pure rules:
// core's fan-out (ticket 20) reads the rows and calls them.

export { notificationKinds };
export type { NotificationKind };

/**
 * A needs-you moment's kind: milestone 3's, and milestone 6's whole-team moments (a draft ready, a
 * review requested, a task's approval, a round's cap, a paused automation), which go through the
 * same fan-out and channels (ADR 0050, F-036).
 */
export type MomentKind = NotificationKind | TeamNotificationKind;

const momentKinds: ReadonlySet<string> = new Set<string>([...notificationKinds, ...teamNotificationKinds]);

/**
 * Whether a stored notification's kind is a needs-you moment. Milestone 4 adds the account and
 * budget kinds to the stored enum; they never go through the needs-you fan-out and delivery.
 */
export const isMomentKind = (kind: string): kind is MomentKind => momentKinds.has(kind);

/** A stored kind the needs-you delivery handles. Any other kind there is a bug, so it throws. */
export const momentKindOf = (kind: string): MomentKind => {
  if (!isMomentKind(kind)) {
    throw new Error(`not a needs-you moment: ${kind}`);
  }
  return kind;
};

/** The three channels of milestone 3. */
export const notificationChannels = ["panel", "tracker", "email"] as const;
export type NotificationChannel = (typeof notificationChannels)[number];

/** A needs-you item's audience, as the item stores it. */
export type ItemAudience = "driver" | "reviewer" | "project_members";

// ---------- the audience ----------

export type AudienceInput = {
  readonly audience: ItemAudience;
  readonly kind: MomentKind;
  readonly driverMemberId: MemberId | null;
  /** The members who can open the task's project now. Nobody else is ever notified. */
  readonly projectMembers: readonly MemberId[];
  /** Milestone 6 (F-102): the task's matched reviewers, for the `reviewer` audience. Missing means none. */
  readonly reviewers?: readonly MemberId[];
};

/** Why a member got a notification, for the mail's footer line. */
export type AudienceReason = "driver" | "project_member";

export type Recipient = { readonly memberId: MemberId; readonly reason: AudienceReason };

/**
 * An item's audience as members (ADR 0050): the driver, or the project's members when the task has
 * no driver. A draft PR ready for review goes to its driver. Milestone 6 (F-102, ADR 0058): the
 * `reviewer` audience is the task's matched reviewers who can open the project, each once, or the
 * driver when none is matched. A member who can no longer open the project gets nothing.
 */
export const resolveAudience = (input: AudienceInput): readonly Recipient[] => {
  const canOpen = new Set<string>(input.projectMembers);
  const audience: ItemAudience = input.kind === "pr_ready" ? "driver" : input.audience;
  const driver = (): readonly Recipient[] => {
    if (input.driverMemberId === null) {
      return input.projectMembers.map((memberId) => ({ memberId, reason: "project_member" }));
    }
    return canOpen.has(input.driverMemberId) ? [{ memberId: input.driverMemberId, reason: "driver" }] : [];
  };
  switch (audience) {
    case "driver":
      return driver();
    case "project_members":
      return input.projectMembers.map((memberId) => ({ memberId, reason: "project_member" }));
    case "reviewer": {
      const reviewers = [...new Set(input.reviewers ?? [])].filter((memberId) => canOpen.has(memberId));
      return reviewers.length === 0
        ? driver()
        : reviewers.map((memberId) => ({ memberId, reason: memberId === input.driverMemberId ? "driver" : "project_member" }));
    }
    default:
      return audience satisfies never;
  }
};

// ---------- the member's choices ----------

/** The moments email is on for by default (ADR 0050). */
const EMAIL_BY_DEFAULT: ReadonlySet<MomentKind> = new Set<MomentKind>([
  "approval",
  "question",
  "plan",
  "pr_ready",
  "crashed",
  "spend_cap",
  // Milestone 6 (ADR 0050): each waits on a person who may not be in the panel.
  "draft_ready",
  "review_requested",
  "task_approval",
  "round_cap",
  "automation_paused",
]);

/** A member's saved choice for one moment and channel. No row means the default. */
export type NotificationChoice = { readonly kind: MomentKind; readonly channel: NotificationChannel; readonly enabled: boolean };

/** A moment's default on a channel: the panel and the ticket always on, email for the moments above. */
export const defaultChoice = (kind: MomentKind, channel: NotificationChannel): boolean => {
  switch (channel) {
    case "panel":
    case "tracker":
      return true;
    case "email":
      return EMAIL_BY_DEFAULT.has(kind);
    default:
      return channel satisfies never;
  }
};

/** Whether the panel's choice can be changed: never, it's always on (ADR 0050). */
export const choiceLocked = (channel: NotificationChannel): boolean => channel === "panel";

/** Whether a member wants a moment on a channel: their saved choice, or the default; the panel always. */
export const wantsChannel = (kind: MomentKind, channel: NotificationChannel, choices: readonly NotificationChoice[]): boolean => {
  if (choiceLocked(channel)) {
    return true;
  }
  const saved = choices.find((choice) => choice.kind === kind && choice.channel === channel);
  return saved?.enabled ?? defaultChoice(kind, channel);
};

/**
 * The channels a delivery goes out on for one member: the panel always; the ticket when the task
 * has one; email when the install has it on and the member has an address; each as they choose.
 */
export const channelsFor = (input: {
  readonly kind: MomentKind;
  readonly choices: readonly NotificationChoice[];
  readonly taskHasTicket: boolean;
  readonly emailOn: boolean;
  readonly memberHasEmail: boolean;
}): readonly NotificationChannel[] =>
  notificationChannels.filter((channel) => {
    if (channel === "tracker" && !input.taskHasTicket) {
      return false;
    }
    if (channel === "email" && (!input.emailOn || !input.memberHasEmail)) {
      return false;
    }
    return wantsChannel(input.kind, channel, input.choices);
  });

/** A delivery's idempotency key: the item (or test), the change, the member and the channel. */
export const deliveryKey = (input: {
  readonly itemId: string;
  readonly change: "created" | "answered" | "dismissed";
  readonly memberId: MemberId;
  readonly channel: NotificationChannel;
}): string => `notify:${input.itemId}:${input.change}:${input.memberId}:${input.channel}`;

/** The change a delivery's key names, or `null` for a key this code didn't make. */
export const deliveryChangeOf = (key: string): "created" | "answered" | "dismissed" | null => {
  const change = key.split(":")[2];
  return change === "created" || change === "answered" || change === "dismissed" ? change : null;
};

// ---------- the ticket's comment ----------

/** The tracker's coalescing window, in minutes (`OSTRA_TRACKER_NOTIFY_COALESCE_MINUTES`, ADR 0050). */
export const TRACKER_COALESCE_MINUTES_DEFAULT = 10;

/** What a ticket delivery does: post a new comment, or edit the task's last one. */
export type TrackerDelivery = { readonly mode: "new" } | { readonly mode: "edit"; readonly providerMessageId: string };

/**
 * The coalescing rule (ADR 0050): a new moment posts a new comment, so the tracker notifies,
 * unless the task's last such comment is within the window, which it edits instead. An answered or
 * dismissed item edits its own comment, to say who answered.
 */
export const trackerDelivery = (input: {
  readonly change: "created" | "answered" | "dismissed";
  /** The task's last notification comment, and when it was posted. */
  readonly lastComment: { readonly providerMessageId: string; readonly postedAt: number } | null;
  /** This item's own comment, once it has one. */
  readonly itemComment: { readonly providerMessageId: string } | null;
  readonly now: number;
  readonly windowMinutes: number;
}): TrackerDelivery => {
  if (input.change !== "created") {
    return input.itemComment === null ? { mode: "new" } : { mode: "edit", providerMessageId: input.itemComment.providerMessageId };
  }
  const last = input.lastComment;
  if (last !== null && input.now - last.postedAt < input.windowMinutes * 60_000) {
    return { mode: "edit", providerMessageId: last.providerMessageId };
  }
  return { mode: "new" };
};

// ---------- the mail ----------

/** How long a mail waits after its moment, in seconds (`OSTRA_EMAIL_DELAY_SECONDS`, ADR 0050). */
export const EMAIL_DELAY_SECONDS_DEFAULT = 120;

/** When an email delivery is due: the moment plus the delay. */
export const emailDueAt = (momentAt: number, delaySeconds: number): number => momentAt + delaySeconds * 1000;

/**
 * Whether a mail that's due still goes out (ADR 0050): not when the member read the notification in
 * the panel, and not when the item is no longer open. A test mail always goes.
 */
export const emailStillNeeded = (input: {
  readonly kind: MomentKind;
  readonly readAt: number | null;
  readonly itemState: "open" | "answered" | "dismissed" | null;
}): boolean => input.kind === "test" || (input.readAt === null && input.itemState === "open");
