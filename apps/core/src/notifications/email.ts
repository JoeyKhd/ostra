import { ResendEmailAdapter } from "@ostra/adapter-email-resend";
import type { ResendEmailAdapterOptions } from "@ostra/adapter-email-resend";
import { SmtpEmailAdapter } from "@ostra/adapter-email-smtp";
import type { SmtpEmailAdapterOptions } from "@ostra/adapter-email-smtp";
import { isRunnerNotice, secretRefSchema } from "@ostra/adapter-sdk";
import type { AccountNotification, AdapterContext, AdapterError, Logger, Notification, NotificationAdapter, Result, RunnerNotificationKind, SecretStoreAdapter, SendResult } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { budgetNoticeIdOfKey, emailStillNeeded, isBudgetNoticeKind, loadBudgetNoticeView, anyMomentHeading, momentKindOf, renderBudgetNoticeMail, renderNeedsYouEmail, spendUrlOf } from "@ostra/domain";
import type { Clock, EmailFromSettings, MomentDetail } from "@ostra/domain";
import { approvalSubjectSchema, memberIdSchema, notificationIdSchema, organizationIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ApprovalSubject } from "@ostra/protocol";

import { loadRunnerNotice, retryable, urlOf, words } from "./deliver.ts";
import type { ChannelOutcome, DeliveryRow, EmailChannel } from "./deliver.ts";

// The email channel (F-115, F-036, ADR 0050, ticket 21). A mail waits its delay; at the due time it
// is skipped when the member read the notification in the panel or the item is no longer open, and
// otherwise it's rendered by the domain's template for the moment and sent through whichever
// provider the install has set up: Resend or SMTP, built from the saved settings (or the install's
// own `OSTRA_EMAIL_*`, which win and lock the panel's choice). Settings changes are seen at the next
// delivery, on every replica, because each delivery reads the row. A mail carries the fields its
// template allows, never ticket text, agent output, a diff or check output; and no mail body, subject
// or address ever reaches a log line.

/** The adapters mail can go through, built per settings. Tests pass others, pointed at fakes. */
export type EmailAdapterFactories = {
  readonly resend: (options: ResendEmailAdapterOptions, context: AdapterContext) => NotificationAdapter;
  readonly smtp: (options: SmtpEmailAdapterOptions, context: AdapterContext) => NotificationAdapter;
};

/** The real adapters: Resend (ticket 12) at `OSTRA_RESEND_API_URL`, and SMTP (ticket 13). */
export const realEmailFactories = (resendApiUrl: string): EmailAdapterFactories => ({
  resend: (options, context) => new ResendEmailAdapter({ ...options, baseUrl: resendApiUrl }, context),
  smtp: (options, context) => new SmtpEmailAdapter(options, context),
});

/**
 * The provider an account mail goes through now (milestone 4, ticket 19), or why there's none: mail
 * off, or settings that can't be used. Account mails skip the delay and the members' choices.
 */
export type AccountSender =
  | { readonly kind: "off" }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "ready"; readonly adapter: string; readonly send: (notification: AccountNotification) => Promise<Result<SendResult, AdapterError>> };

export type EmailChannelDeps = {
  readonly db: Db;
  readonly secretStore: SecretStoreAdapter;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `OSTRA_PUBLIC_URL`: the mail's links and its mark are served from it. */
  readonly publicUrl: string;
  /** `OSTRA_SESSION_STALL_MINUTES`, for the stall mail's one line. */
  readonly stallMinutes: number;
  /** `OSTRA_INTAKE_STARTS_PER_HOUR`, for a paused automation's one line (milestone 6). */
  readonly intakeStartsPerHour?: number;
  /** `OSTRA_EMAIL_*` as the install's settings gave them. */
  readonly fromSettings: EmailFromSettings;
  readonly factories: EmailAdapterFactories;
};

/** `OSTRA_INTAKE_STARTS_PER_HOUR`'s default, when the caller doesn't pass the setting. */
const INTAKE_STARTS_PER_HOUR_DEFAULT = 20;

/** What mail is set up to go through, with its secrets resolved. Never logged. */
type EmailConfig =
  | { readonly provider: "off" }
  | { readonly provider: "resend"; readonly apiKey: string; readonly from: string; readonly fromName: string }
  | ({ readonly provider: "smtp" } & SmtpEmailAdapterOptions);

type Configured = { readonly fingerprint: string; readonly config: EmailConfig } | { readonly failed: string };

const closeIfClosable = (adapter: NotificationAdapter): void => {
  // Only the SMTP adapter holds a pooled transport to close.
  const close: unknown = Reflect.get(adapter, "close");
  if (typeof close === "function") {
    Reflect.apply(close, adapter, []);
  }
};

/** A task's spend, as a mail says it. */
const usd = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(2)}`;

const askedAtOf = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export const createEmailChannel = (deps: EmailChannelDeps): EmailChannel & { readonly accountSender: () => Promise<AccountSender>; readonly close: () => void } => {
  const context: AdapterContext = { logger: deps.logger, clock: { now: () => deps.clock.now() } };
  // The adapter in use, kept while the settings stay as they were; a change rebuilds it.
  let current: { readonly fingerprint: string; readonly adapter: NotificationAdapter } | null = null;

  /** The provider and its secrets, from the install's settings or the saved row. */
  const configOf = async (): Promise<Configured> => {
    const settings = deps.fromSettings;
    if (settings.source === "settings") {
      // The install's settings win; the row only mirrors them for the panel.
      const fingerprint = `settings:${settings.provider}`;
      switch (settings.provider) {
        case "off":
          return { fingerprint, config: { provider: "off" } };
        case "resend":
          return { fingerprint, config: { provider: "resend", apiKey: settings.apiKey, from: settings.from, fromName: settings.fromName } };
        case "smtp":
          return {
            fingerprint,
            config: {
              provider: "smtp",
              host: settings.host,
              port: settings.port,
              secure: settings.secure,
              from: settings.from,
              fromName: settings.fromName,
              ...(settings.user === null ? {} : { user: settings.user }),
              ...(settings.password === null ? {} : { password: settings.password }),
            },
          };
        default:
          return settings satisfies never;
      }
    }
    const row = await deps.db.emailSettings.findUnique({ where: { id: "instance" } });
    if (row === null || row.provider === "off") {
      return { fingerprint: "off", config: { provider: "off" } };
    }
    const fingerprint = `${row.provider}:${String(row.updatedAt.getTime())}`;
    if (row.fromAddress === null) {
      return { failed: "the email settings are incomplete" };
    }
    const from = row.fromAddress;
    const fromName = row.fromName ?? settings.fromName;
    // Set only once a secret was saved: an SMTP relay with no password (a local relay, the dev mail
    // sink) has none, and needs none.
    const organizationId = row.secretsOrganizationId === null ? null : organizationIdSchema.parse(row.secretsOrganizationId);
    const secret = async (value: string | null): Promise<string | null> => {
      const ref = value === null ? null : secretRefSchema.safeParse(value);
      if (ref?.success !== true || organizationId === null) {
        return null;
      }
      const read = await deps.secretStore.get(organizationId, ref.data);
      return read.ok ? read.value : null;
    };
    if (row.provider === "resend") {
      const apiKey = await secret(row.resendApiKeySecretRef);
      return apiKey === null ? { failed: "the Resend key can't be read from the secret store" } : { fingerprint, config: { provider: "resend", apiKey, from, fromName } };
    }
    if (row.smtpHost === null || row.smtpPort === null || row.smtpSecure === null) {
      return { failed: "the SMTP settings are incomplete" };
    }
    const password = await secret(row.smtpPasswordSecretRef);
    if (row.smtpPasswordSecretRef !== null && password === null) {
      return { failed: "the SMTP password can't be read from the secret store" };
    }
    return {
      fingerprint,
      config: {
        provider: "smtp",
        host: row.smtpHost,
        port: row.smtpPort,
        secure: row.smtpSecure,
        from,
        fromName,
        ...(row.smtpUser === null ? {} : { user: row.smtpUser }),
        ...(password === null ? {} : { password }),
      },
    };
  };

  const adapterFor = (fingerprint: string, config: Exclude<EmailConfig, { readonly provider: "off" }>): NotificationAdapter => {
    if (current?.fingerprint === fingerprint) {
      return current.adapter;
    }
    const adapter =
      config.provider === "resend"
        ? deps.factories.resend({ apiKey: config.apiKey, from: config.from, fromName: config.fromName }, context)
        : deps.factories.smtp(
            {
              host: config.host,
              port: config.port,
              secure: config.secure,
              from: config.from,
              ...(config.fromName === undefined ? {} : { fromName: config.fromName }),
              ...(config.user === undefined ? {} : { user: config.user }),
              ...(config.password === undefined ? {} : { password: config.password }),
            },
            context,
          );
    if (current !== null) {
      closeIfClosable(current.adapter);
    }
    current = { fingerprint, adapter };
    return adapter;
  };

  /** The moment's one line, from the rows (never from the moment's own text). */
  const detailOf = async (row: DeliveryRow): Promise<MomentDetail> => {
    const { task, needsYouItem: item } = row.notification;
    const kind = momentKindOf(row.notification.kind);
    switch (kind) {
      case "approval": {
        const approval =
          item?.approvalId === null || item === null
            ? null
            : await deps.db.approval.findUnique({ where: { id: item.approvalId }, select: { subjectKind: true, subjectValue: true } });
        const subject = approvalSubjectSchema.safeParse({ kind: approval?.subjectKind, value: approval?.subjectValue });
        const fallback: ApprovalSubject = { kind: "tool", value: "a tool" };
        return { kind, subject: subject.success ? subject.data : fallback };
      }
      case "question":
        return { kind, askedAt: askedAtOf(item?.createdAt ?? new Date(deps.clock.now())) };
      case "plan": {
        const turnId = item?.planTurnId ?? null;
        const proposed = await deps.db.event.findFirst({
          where: { taskId: task?.id ?? "", kind: "plan.proposed", ...(turnId === null ? {} : { payload: { path: ["turnId"], equals: turnId } }) },
          orderBy: { seq: "desc" },
          select: { payload: true },
        });
        const payload: unknown = proposed?.payload;
        const entries = typeof payload === "object" && payload !== null && "entries" in payload && Array.isArray(payload.entries) ? payload.entries.length : 0;
        return { kind, steps: entries };
      }
      case "pr_ready":
        return { kind, pullRequests: await deps.db.taskPullRequest.count({ where: { taskRepo: { taskId: task?.id ?? "" } } }) };
      case "no_changes":
      case "crashed":
      case "setup_failed":
      case "test":
        return { kind };
      case "stalled":
        return { kind, minutes: deps.stallMinutes };
      case "spend_cap":
        return { kind, spent: usd(task?.spentMicroUsd ?? 0) };
      case "ticket_closed":
        return { kind, status: task?.ticket?.statusName ?? "closed" };
      // ---- milestone 6 (F-036, ADR 0050): counts and names, never a draft's or a finding's text ----
      case "draft_ready": {
        const draft = await deps.db.refineDraft.findFirst({
          where: { taskId: task?.id ?? "" },
          orderBy: { version: "desc" },
          select: { acceptanceCriteria: true, subTickets: true },
        });
        const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
        return { kind, acceptanceCriteria: count(draft?.acceptanceCriteria), subTickets: count(draft?.subTickets) };
      }
      case "review_requested":
        return { kind, pullRequests: await deps.db.taskPullRequest.count({ where: { taskRepo: { taskId: task?.id ?? "" } } }) };
      case "task_approval":
        return { kind, startedBy: task?.trackerActorName ?? "someone outside the project" };
      case "round_cap":
        return { kind, reason: "rounds", turns: task?.automaticTurns ?? 0 };
      case "automation_paused":
        return { kind, starts: deps.intakeStartsPerHour ?? INTAKE_STARTS_PER_HOUR_DEFAULT };
      default:
        return kind satisfies never;
    }
  };

  /**
   * Milestone 4 (F-037, F-115, ticket 13): a budget notice's mail, rendered from the notice when it's
   * due, to the admin it's for. Skipped once they read it in the panel, or when the notice is gone.
   */
  const deliverBudgetNotice = async (
    row: DeliveryRow,
    kind: "budget_warning" | "budget_reached",
    fingerprint: string,
    config: Exclude<EmailConfig, { readonly provider: "off" }>,
  ): Promise<ChannelOutcome> => {
    const stored = row.notification;
    if (stored.readAt !== null) {
      return { outcome: "skipped", why: "read" };
    }
    const organizationId = organizationIdSchema.parse(row.organizationId);
    const noticeId = budgetNoticeIdOfKey(row.idempotencyKey);
    const view = noticeId === null ? null : await loadBudgetNoticeView(deps.db, organizationId, noticeId);
    if (view === null) {
      return { outcome: "skipped", why: "closed" };
    }
    const address = stored.member.user.email.trim();
    if (address === "") {
      return { outcome: "skipped", why: "no-address" };
    }
    const memberId = memberIdSchema.parse(stored.memberId);
    const rendered = renderBudgetNoticeMail(view, deps.publicUrl);
    const sent = await adapterFor(fingerprint, config).send({
      organizationId,
      memberIds: [memberId],
      title: rendered.subject,
      body: rendered.subject,
      url: spendUrlOf(deps.publicUrl, view.projectId),
      idempotencyKey: row.idempotencyKey,
      kind,
      recipients: [{ memberId, email: address, trackerMention: null }],
      subject: view.budgetName,
      rendered,
      notificationId: notificationIdSchema.parse(stored.id),
      taskId: null,
      ticket: null,
    });
    if (!sent.ok) {
      return { outcome: "failed", error: words(sent.error), retryable: retryable(sent.error) };
    }
    const refused = sent.value.refused.find((entry) => entry.memberId === memberId);
    if (refused !== undefined) {
      return { outcome: "failed", error: `the mail provider refused the address: ${refused.reason}`.slice(0, 500), retryable: false };
    }
    return { outcome: "sent", providerMessageId: sent.value.providerMessageId };
  };

  /**
   * Milestone 5 (F-091, ticket 12): a runner notice's mail to an admin, rendered from the runner when
   * it's due. Skipped once they read it in the panel, the runner is gone, or the approval is answered.
   */
  const deliverRunnerNotice = async (
    row: DeliveryRow,
    kind: RunnerNotificationKind,
    fingerprint: string,
    config: Exclude<EmailConfig, { readonly provider: "off" }>,
  ): Promise<ChannelOutcome> => {
    const stored = row.notification;
    if (stored.readAt !== null) {
      return { outcome: "skipped", why: "read" };
    }
    const notice = await loadRunnerNotice(deps, row, kind);
    if (notice === null) {
      return { outcome: "skipped", why: "closed" };
    }
    const address = stored.member.user.email.trim();
    if (address === "") {
      return { outcome: "skipped", why: "no-address" };
    }
    const memberId = memberIdSchema.parse(stored.memberId);
    const sent = await adapterFor(fingerprint, config).send({
      organizationId: notice.organizationId,
      memberIds: [memberId],
      title: notice.rendered.email.subject,
      body: notice.rendered.email.subject,
      url: notice.runner.url,
      idempotencyKey: row.idempotencyKey,
      kind,
      recipients: [{ memberId, email: address, trackerMention: null }],
      subject: notice.runner.runnerName,
      rendered: notice.rendered.email,
      notificationId: notificationIdSchema.parse(stored.id),
      taskId: null,
      ticket: null,
      runner: notice.runner,
    });
    if (!sent.ok) {
      return { outcome: "failed", error: words(sent.error), retryable: retryable(sent.error) };
    }
    const refused = sent.value.refused.find((entry) => entry.memberId === memberId);
    if (refused !== undefined) {
      return { outcome: "failed", error: `the mail provider refused the address: ${refused.reason}`.slice(0, 500), retryable: false };
    }
    return { outcome: "sent", providerMessageId: sent.value.providerMessageId };
  };

  const deliver = async (row: DeliveryRow): Promise<ChannelOutcome> => {
    const configured = await configOf();
    if ("failed" in configured) {
      // The settings can't be used as saved: another attempt after a fix may work, so it retries.
      return { outcome: "failed", error: configured.failed, retryable: true };
    }
    if (configured.config.provider === "off") {
      return { outcome: "skipped", why: "mail-off" };
    }
    const { notification: stored } = row;
    if (isBudgetNoticeKind(stored.kind)) {
      return deliverBudgetNotice(row, stored.kind, configured.fingerprint, configured.config);
    }
    if (isRunnerNotice(stored.kind)) {
      return deliverRunnerNotice(row, stored.kind, configured.fingerprint, configured.config);
    }
    // Due now: a member who read it in the panel meanwhile, or an item closed meanwhile, needs no mail.
    const kind = momentKindOf(stored.kind);
    if (!emailStillNeeded({ kind, readAt: stored.readAt?.getTime() ?? null, itemState: stored.needsYouItem?.state ?? null })) {
      return { outcome: "skipped", why: stored.readAt === null ? "closed" : "read" };
    }
    // Milestone 4's verification (F-002) restricts mail to a verified address; until then the account's address is used.
    const address = stored.member.user.email.trim();
    if (address === "") {
      return { outcome: "skipped", why: "no-address" };
    }
    const organization = await deps.db.organization.findUnique({ where: { id: row.organizationId }, select: { name: true } });
    const task = stored.task;
    const rendered = renderNeedsYouEmail({
      detail: await detailOf(row),
      organizationName: organization?.name ?? "ostra",
      projectName: task?.project.name ?? null,
      task: task === null ? null : { title: task.title, key: task.ticketKey, url: urlOf(deps, row) },
      reason: task?.driverMemberId === stored.memberId ? "driver" : "project_member",
      publicUrl: deps.publicUrl,
    });
    const memberId = memberIdSchema.parse(stored.memberId);
    const notification: Notification = {
      organizationId: organizationIdSchema.parse(row.organizationId),
      memberIds: [memberId],
      title: anyMomentHeading[kind],
      body: anyMomentHeading[kind],
      url: urlOf(deps, row),
      idempotencyKey: row.idempotencyKey,
      kind,
      recipients: [{ memberId, email: address, trackerMention: null }],
      subject: task?.title ?? "",
      rendered,
      notificationId: notificationIdSchema.parse(stored.id),
      taskId: task === null ? null : taskIdSchema.parse(task.id),
      ticket: null,
    };
    const sent = await adapterFor(configured.fingerprint, configured.config).send(notification);
    if (!sent.ok) {
      return { outcome: "failed", error: words(sent.error), retryable: retryable(sent.error) };
    }
    const refused = sent.value.refused.find((entry) => entry.memberId === memberId);
    if (refused !== undefined) {
      // The provider refused this address alone; trying again won't change it.
      return { outcome: "failed", error: `the mail provider refused the address: ${refused.reason}`.slice(0, 500), retryable: false };
    }
    return { outcome: "sent", providerMessageId: sent.value.providerMessageId };
  };

  const accountSender = async (): Promise<AccountSender> => {
    const configured = await configOf();
    if ("failed" in configured) {
      return { kind: "failed", error: configured.failed };
    }
    if (configured.config.provider === "off") {
      return { kind: "off" };
    }
    const adapter = adapterFor(configured.fingerprint, configured.config);
    return { kind: "ready", adapter: adapter.name, send: (notification) => adapter.send(notification) };
  };

  return {
    deliver,
    accountSender,
    close: () => {
      if (current !== null) {
        closeIfClosable(current.adapter);
        current = null;
      }
    },
  };
};
