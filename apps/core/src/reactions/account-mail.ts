import type { AccountNotification, Logger, RenderedEmail } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import {
  invitationLink,
  mintMembershipVerification,
  mintPasswordReset,
  renderInvitationMail,
  renderPasswordResetMail,
  renderVerificationMail,
  resetLink,
  verificationLink,
} from "@ostra/domain";
import type { Clock, JobPayload } from "@ostra/domain";
import { queueSettings } from "@ostra/jobs";
import type { JobHandler } from "@ostra/jobs";
import { memberIdSchema } from "@ostra/protocol";

import { retryable, words } from "../notifications/deliver.ts";
import type { AccountSender } from "../notifications/email.ts";

// `account-mail.send` (F-002, F-115, ADR 0053; ticket 19): one account mail, keyed by its purpose
// and record ID. It reads the record, checks it's still pending (a revoked, used or expired
// invitation, a membership already verified, or a reset link used or expired sends nothing), makes
// the link, renders the domain's template and sends it through the install's email channel as the
// `account` category: at once, with no member choices. The delivery row keeps each send once (a
// replayed job finds it `sent`) and the provider's words of a failure, for the invitation's row.
// The link exists only in memory for the send: never in a log line, an error, the job's payload
// (the record's ID) or the delivery row. An invitation's link is its ID (ADR 0053), so a log line
// names the delivery row, never the record.

export type AccountMailDeps = {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `OSTRA_PUBLIC_URL`: the links point at the panel. */
  readonly publicUrl: string;
  /** The email channel's provider, read at each send (`createEmailChannel`'s `accountSender`). */
  readonly accountSender: () => Promise<AccountSender>;
  /** `OSTRA_RESET_LINK_HOURS`: a verification link works as long as a reset link (ticket 42's decision). */
  readonly verificationHours: number;
};

type Payload = JobPayload<"account-mail.send">;

/** What one purpose's record gives the mail, or why nothing is sent. Never logged. */
type Prepared =
  | { readonly send: false; readonly why: string }
  | { readonly send: true; readonly to: string; readonly memberId: string | null; readonly subject: string; readonly render: (tx: Tx) => Promise<RenderedEmail> };

const organizationNameOf = async (db: Db, organizationId: string): Promise<string> =>
  (await db.organization.findUnique({ where: { id: organizationId }, select: { name: true } }))?.name ?? "ostra";

const prepare = async (deps: AccountMailDeps, payload: Payload): Promise<Prepared> => {
  const now = deps.clock.now();
  const organizationName = await organizationNameOf(deps.db, payload.organizationId);
  switch (payload.purpose) {
    case "invitation": {
      const invitation = await deps.db.invitation.findFirst({
        where: { id: payload.recordId, organizationId: payload.organizationId },
        select: { id: true, email: true, role: true, status: true, expiresAt: true, acceptedAt: true, revokedAt: true, user: { select: { name: true } } },
      });
      if (invitation === null) {
        return { send: false, why: "the invitation is gone" };
      }
      if (invitation.revokedAt !== null || invitation.status === "canceled" || invitation.status === "rejected") {
        return { send: false, why: "the invitation was revoked" };
      }
      if (invitation.acceptedAt !== null || invitation.status === "accepted") {
        return { send: false, why: "the invitation was accepted" };
      }
      if (invitation.expiresAt.getTime() <= now) {
        return { send: false, why: "the invitation expired" };
      }
      const link = invitationLink(deps.publicUrl, invitation.id);
      const rendered = renderInvitationMail({
        organizationName,
        inviterName: invitation.user.name,
        address: invitation.email,
        role: invitation.role === "admin" ? "admin" : "member",
        link,
        expiresAt: invitation.expiresAt.getTime(),
        publicUrl: deps.publicUrl,
      });
      return { send: true, to: invitation.email, memberId: null, subject: organizationName, render: () => Promise.resolve(rendered) };
    }
    case "email_verification": {
      const member = await deps.db.member.findFirst({
        where: { id: payload.recordId, organizationId: payload.organizationId },
        select: { id: true, state: true, userId: true, user: { select: { email: true, username: true } } },
      });
      if (member === null) {
        return { send: false, why: "the membership is gone" };
      }
      if (member.state !== "pending_verification") {
        return { send: false, why: member.state === "active" ? "the membership is verified" : "the membership was removed" };
      }
      const invitation = await deps.db.invitation.findFirst({
        where: { organizationId: payload.organizationId, acceptedUserId: member.userId },
        orderBy: { acceptedAt: "desc" },
        select: { id: true },
      });
      if (invitation === null) {
        return { send: false, why: "the membership came from no invitation" };
      }
      const expiresAt = new Date(now + deps.verificationHours * 3_600_000);
      return {
        send: true,
        to: member.user.email,
        memberId: member.id,
        subject: organizationName,
        render: async (tx) => {
          const token = await mintMembershipVerification(tx, { memberId: member.id, expiresAt });
          return renderVerificationMail({
            organizationName,
            address: member.user.email,
            username: member.user.username,
            link: verificationLink(deps.publicUrl, invitation.id, token),
            expiresAt: expiresAt.getTime(),
            publicUrl: deps.publicUrl,
          });
        },
      };
    }
    case "password_reset": {
      const grant = await deps.db.resetLinkGrant.findUnique({
        where: { id: payload.recordId },
        select: { id: true, userId: true, usedAt: true, expiresAt: true, createdAt: true, user: { select: { email: true, members: { where: { organizationId: payload.organizationId }, select: { id: true } } } } },
      });
      // The grant is the install's; the payload's organization is one the account belongs to.
      if (grant?.user.members.length !== 1) {
        return { send: false, why: "the reset link is gone" };
      }
      if (grant.usedAt !== null) {
        return { send: false, why: "the reset link was used" };
      }
      if (grant.expiresAt.getTime() <= now) {
        return { send: false, why: "the reset link expired" };
      }
      const expiresAt = grant.expiresAt;
      return {
        send: true,
        to: grant.user.email,
        memberId: grant.user.members[0]?.id ?? null,
        subject: organizationName,
        render: async (tx) => {
          const token = await mintPasswordReset(tx, { grantId: grant.id, userId: grant.userId, expiresAt });
          return renderPasswordResetMail({
            organizationName,
            address: grant.user.email,
            link: resetLink(deps.publicUrl, token),
            expiresAt: expiresAt.getTime(),
            hours: Math.max(1, Math.round((expiresAt.getTime() - grant.createdAt.getTime()) / 3_600_000)),
            publicUrl: deps.publicUrl,
          });
        },
      };
    }
    default:
      return payload.purpose satisfies never;
  }
};

/** The link a rendered mail carries: the button's, which is in both parts. Held for the send only. */
const linkOf = (rendered: RenderedEmail): string => /href="([^"]+)"/.exec(rendered.html)?.[1]?.replaceAll("&amp;", "&") ?? "";

export const accountMailSendHandler =
  (deps: AccountMailDeps): JobHandler<"account-mail.send"> =>
  async (context) => {
    const { payload } = context;
    const where = { purpose_recordId: { purpose: payload.purpose, recordId: payload.recordId } } as const;
    const row = await deps.db.accountMailDelivery.upsert({
      where,
      create: { organizationId: payload.organizationId, purpose: payload.purpose, recordId: payload.recordId },
      update: {},
      select: { id: true, organizationId: true, state: true, attempts: true },
    });
    if (row.organizationId !== payload.organizationId) {
      // A record ID is unique across the install: another organization's can't be sent from here.
      context.logger.warn("account-mail.other-organization", { purpose: payload.purpose, deliveryId: row.id });
      return;
    }
    if (row.state !== "pending") {
      // A replayed job: sent, skipped or failed for good already. Nothing twice.
      return;
    }
    const finish = async (data: { readonly state: "sent" | "skipped" | "failed" | "pending"; readonly error: string | null; readonly adapter?: string; readonly providerMessageId?: string | null }) => {
      await deps.db.accountMailDelivery.update({
        where: { id: row.id },
        data: {
          state: data.state,
          error: data.error,
          ...(data.adapter === undefined ? {} : { adapter: data.adapter }),
          ...(data.providerMessageId === undefined ? {} : { providerMessageId: data.providerMessageId }),
          ...(data.state === "sent" ? { sentAt: new Date(deps.clock.now()) } : {}),
          ...(data.state === "skipped" ? {} : { attempts: { increment: 1 } }),
        },
      });
      // The delivery's own ID, never the record's: an invitation's ID is its link (ADR 0053).
      context.logger.info("account-mail.done", { purpose: payload.purpose, deliveryId: row.id, outcome: data.state });
    };

    const prepared = await prepare(deps, payload);
    if (!prepared.send) {
      await finish({ state: "skipped", error: prepared.why });
      return;
    }
    const sender = await deps.accountSender();
    if (sender.kind === "off") {
      // Mail was switched off after it was asked for: the panel's copy-link path is the only one.
      await finish({ state: "skipped", error: "email is off" });
      return;
    }
    const exhausted = context.retryCount >= queueSettings["account-mail.send"].retryLimit;
    const failed = async (error: string, again: boolean): Promise<void> => {
      const willRetry = again && !exhausted;
      await finish({ state: willRetry ? "pending" : "failed", error });
      if (willRetry) {
        throw new Error("the account mail failed and will be tried again");
      }
    };
    if (sender.kind === "failed") {
      await failed(sender.error, true);
      return;
    }
    // The token's row commits before the mail goes, so the link works the moment it arrives.
    const rendered = await deps.db.$transaction((tx) => prepared.render(tx));
    const notification: AccountNotification = {
      category: "account",
      kind: payload.purpose,
      organizationId: payload.organizationId,
      title: rendered.subject,
      body: rendered.subject,
      url: linkOf(rendered),
      idempotencyKey: `account-mail:${payload.purpose}:${payload.recordId}:${String(row.attempts + 1)}`,
      subject: prepared.subject,
      to: { email: prepared.to, memberId: prepared.memberId === null ? null : memberIdSchema.parse(prepared.memberId) },
      rendered,
    };
    let sent: Awaited<ReturnType<typeof sender.send>>;
    try {
      sent = await sender.send(notification);
    } catch (error) {
      await failed(`${error instanceof Error ? error.name : "error"} while sending`, true);
      return;
    }
    if (!sent.ok) {
      await failed(words(sent.error), retryable(sent.error));
      return;
    }
    if (sent.value.refused.length > 0) {
      // The provider refused the address itself: trying again won't change it.
      await failed(`the mail provider refused the address: ${sent.value.refused[0]?.reason ?? "refused"}`.slice(0, 500), false);
      return;
    }
    await finish({ state: "sent", error: null, adapter: sender.adapter, providerMessageId: sent.value.providerMessageId });
  };
