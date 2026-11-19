import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Tx } from "@ostra/db";
import { invitationIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, userIdSchema } from "@ostra/protocol";
import type { InvitationId, MemberId, OrganizationId, UserId } from "@ostra/protocol";
import { z } from "zod";

import { requireOrganizationAdmin } from "../access.ts";
import type { OrganizationRole } from "../access.ts";
import { membershipOnAccept, transitionInvitation } from "../lifecycles/m4.ts";
import type { InvitationLifecycle } from "../lifecycles/m4.ts";
import type { AcceptInvitation, InviteMember, M4Deps, ProjectGrant, RevokeInvitation } from "./m4-signatures.ts";

// F-002 (ADR 0053, ticket 22): invitations. An organization admin invites an address with a role
// and, optionally, projects with a role each; the invitation's ID is the link's secret (192 random
// bits); it works once, for `OSTRA_INVITATION_DAYS`, until it's revoked. Accepting it (through the
// sign-up hook, or a signed-in account) makes the membership and its project grants in the same
// transaction as the account, `pending_verification` while the install's email must prove the
// address. The rows are better-auth's `invitation` and `member`, written by ostra so its grants,
// its audit entry and its mail job commit with them.

/** The bytes of an invitation's ID: the link's secret, at least 128 bits (ADR 0053). */
const INVITATION_ID_BYTES = 24;

/** A new invitation's ID: URL-safe, 192 random bits. Never logged. */
export const newInvitationId = (): InvitationId => invitationIdSchema.parse(randomBytes(INVITATION_ID_BYTES).toString("base64url"));

/**
 * What the panel and the audit log call an invitation by. The ID is the link's secret, so after the
 * one answer that shows the link, nothing returns it: the list, a revoke and every audit entry use
 * this handle, a hash of it, from which the link can't be made.
 */
export const invitationHandleOf = (invitationId: string): string => createHash("sha256").update(`invitation:${invitationId}`).digest("hex").slice(0, 32);

/** What `Invitation.projectGrants` holds: the projects an invitation grants, with a role each. */
export const projectGrantsSchema = z.array(z.strictObject({ projectId: projectIdSchema, role: z.enum(["admin", "member"]) })).max(100);

/** The address an account and an invitation are compared by: trimmed, lower case. */
export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

/** The invitation row's columns the lifecycle reads. */
export type InvitationRow = {
  readonly status: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly acceptedUserId: string | null;
  readonly revokedAt: Date | null;
  readonly revokedByMemberId: string | null;
};

/**
 * The invitation's lifecycle from its row, at `now`. better-auth's own status words count too: its
 * `canceled` is a revoke, its `accepted` an acceptance; a pending row past its expiry is expired
 * whether or not the sweep has marked it.
 */
export const invitationLifecycleOf = (row: InvitationRow, now: number): InvitationLifecycle => {
  if (row.revokedAt !== null || row.status === "canceled" || row.status === "rejected") {
    return {
      state: "revoked",
      revokedAt: (row.revokedAt ?? row.expiresAt).getTime(),
      revokedByMemberId: memberIdSchema.parse(row.revokedByMemberId ?? "unknown"),
    };
  }
  if (row.acceptedAt !== null || row.status === "accepted") {
    return { state: "accepted", acceptedAt: (row.acceptedAt ?? row.expiresAt).getTime(), acceptedUserId: userIdSchema.parse(row.acceptedUserId ?? "unknown") };
  }
  if (row.status === "expired" || row.expiresAt.getTime() <= now) {
    return { state: "expired" };
  }
  return { state: "pending", expiresAt: row.expiresAt.getTime() };
};

const fail = <E extends string>(error: E, message: string) => ({ ok: false as const, error, message });

/** The account a member row belongs to: what `Invitation.inviterId` names. */
const userOfMember = async (tx: Tx, organizationId: OrganizationId, memberId: MemberId): Promise<UserId | null> => {
  const row = await tx.member.findFirst({ where: { id: memberId, organizationId }, select: { userId: true } });
  return row === null ? null : userIdSchema.parse(row.userId);
};

export const inviteMember: InviteMember = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return fail("forbidden", "Only an organization admin may invite");
  }
  const email = normalizeAddress(input.email);
  if (!z.email().safeParse(email).success) {
    return fail("invalid-input", "That isn't an email address");
  }
  const projectIds = input.projectGrants.map((grant) => grant.projectId);
  if (new Set(projectIds).size !== projectIds.length) {
    return fail("invalid-input", "Each project is granted once");
  }
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const inviter = await userOfMember(tx, organizationId, scope.memberId);
    if (inviter === null) {
      return fail("forbidden", "Only an organization admin may invite");
    }
    const existing = await tx.member.findFirst({
      where: { organizationId, state: { in: ["active", "pending_verification"] }, user: { email } },
      select: { id: true },
    });
    if (existing !== null) {
      return fail("already-member", "That address already belongs to a member");
    }
    const pending = await tx.invitation.findFirst({
      where: { organizationId, email, status: "pending", revokedAt: null, acceptedAt: null, expiresAt: { gt: new Date(now) } },
      select: { id: true },
    });
    if (pending !== null) {
      return fail("already-invited", "That address has an invitation waiting: revoke it to send a new one");
    }
    const projects = await tx.project.findMany({ where: { organizationId, id: { in: projectIds } }, select: { id: true } });
    if (projects.length !== projectIds.length) {
      return fail("not-found", "No such project");
    }
    const invitationId = newInvitationId();
    const expiresAt = now + input.days * 24 * 60 * 60 * 1000;
    const grants: ProjectGrant[] = input.projectGrants.map((grant) => ({ projectId: grant.projectId, role: grant.role }));
    await tx.invitation.create({
      data: {
        id: invitationId,
        organizationId,
        email,
        role: input.role,
        status: "pending",
        expiresAt: new Date(expiresAt),
        createdAt: new Date(now),
        inviterId: inviter,
        projectGrants: grants,
        // The panel shows the link once, now; no later read returns it.
        linkShownAt: new Date(now),
      },
    });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "invitation.created",
      entity: "invitation",
      entityId: null,
      data: { invitation: invitationHandleOf(invitationId), role: input.role, projects: grants.length, mailed: input.emailOn },
    });
    if (input.emailOn) {
      await deps.jobs.enqueueInTx(tx, "account-mail.send", { organizationId, purpose: "invitation", recordId: invitationId });
    }
    // The members page reads invitations with the organization: it refreshes on its notice.
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return { ok: true as const, invitationId, expiresAt };
  });
};

export const revokeInvitation: RevokeInvitation = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return fail("forbidden", "Only an organization admin may revoke an invitation");
  }
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const row = await tx.invitation.findFirst({ where: { id: input.invitationId, organizationId } });
    if (row === null) {
      return fail("not-found", "No such invitation");
    }
    const moved = transitionInvitation(invitationLifecycleOf(row, now), { type: "revoke", at: now, byMemberId: scope.memberId });
    if (!moved.ok) {
      return fail("not-pending", "That invitation is no longer waiting");
    }
    // A conditional write: an acceptance that commits first wins, and this one changes nothing.
    const changed = await tx.invitation.updateMany({
      where: { id: row.id, status: "pending", acceptedAt: null, revokedAt: null },
      data: { status: "canceled", revokedAt: new Date(now), revokedByMemberId: scope.memberId },
    });
    if (changed.count !== 1) {
      return fail("not-pending", "That invitation is no longer waiting");
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "invitation.revoked",
      entity: "invitation",
      entityId: null,
      data: { invitation: invitationHandleOf(row.id) },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    return { ok: true as const, revokedAt: now };
  });
};

const roleOf = (stored: string | null): OrganizationRole => (stored === "admin" ? "admin" : "member");

/**
 * Accepts an invitation for an account, inside the caller's transaction: the sign-up's (better-auth's
 * `/sign-up/email`, so the account and the membership commit together) or a signed-in account's. The
 * invitation is marked accepted by a conditional write, so it works once even when two accept at once.
 * With email on, the account's address must be the invitation's, and the membership waits for the
 * address to be verified (a verification mail is enqueued) unless the account's already is.
 */
/** What accepting writes through: no adapter and no outbox, so better-auth's hook can call it. */
export type AcceptInvitationDeps = Pick<M4Deps, "jobs" | "audit" | "notices" | "clock">;

export const acceptInvitation = async (
  deps: AcceptInvitationDeps,
  tx: Tx,
  input: Parameters<AcceptInvitation>[2],
): ReturnType<AcceptInvitation> => {
  const now = deps.clock.now();
  const row = await tx.invitation.findUnique({ where: { id: input.invitationId } });
  if (row === null) {
    return fail("not-found", "No such invitation");
  }
  const lifecycle = invitationLifecycleOf(row, now);
  const moved = transitionInvitation(lifecycle, { type: "accept", at: now, userId: input.userId });
  if (!moved.ok) {
    switch (lifecycle.state) {
      case "accepted":
        return fail("used", "This invitation has been used");
      case "revoked":
        return fail("revoked", "This invitation was revoked");
      case "expired":
      case "pending":
        return fail("expired", "This invitation has expired");
      default:
        return lifecycle satisfies never;
    }
  }
  if (input.emailOn && normalizeAddress(input.email) !== normalizeAddress(row.email)) {
    return fail("address-mismatch", "This invitation is for another address");
  }
  const organizationId = organizationIdSchema.parse(row.organizationId);
  const existing = await tx.member.findUnique({
    where: { organizationId_userId: { organizationId, userId: input.userId } },
    select: { id: true, state: true },
  });
  if (existing !== null && existing.state !== "removed") {
    return fail("already-member", "This account is already a member");
  }
  const claimed = await tx.invitation.updateMany({
    where: { id: row.id, status: "pending", acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date(now) } },
    data: { status: "accepted", acceptedAt: new Date(now), acceptedUserId: input.userId },
  });
  if (claimed.count !== 1) {
    return fail("used", "This invitation has been used");
  }
  const account = await tx.user.findUnique({ where: { id: input.userId }, select: { emailVerified: true } });
  const membership = membershipOnAccept(input.emailOn && account?.emailVerified !== true);
  const role = roleOf(row.role);
  // A removed member invited again comes back on the same row (one membership per account and
  // organization); the removal stays in the audit log.
  const memberId = memberIdSchema.parse(existing?.id ?? randomUUID());
  if (existing === null) {
    await tx.member.create({ data: { id: memberId, organizationId, userId: input.userId, role, state: membership.state, createdAt: new Date(now) } });
  } else {
    await tx.member.update({ where: { id: memberId }, data: { role, state: membership.state, removedAt: null, removedByMemberId: null } });
  }
  const grants = projectGrantsSchema.safeParse(row.projectGrants);
  const wanted = grants.success ? grants.data : [];
  // A project deleted since the invitation was made is skipped.
  const still = new Set(
    (await tx.project.findMany({ where: { organizationId, id: { in: wanted.map((grant) => grant.projectId) } }, select: { id: true } })).map((project) => project.id),
  );
  for (const grant of wanted.filter((candidate) => still.has(candidate.projectId))) {
    await tx.projectMember.upsert({
      where: { projectId_memberId: { projectId: grant.projectId, memberId } },
      create: { organizationId, projectId: grant.projectId, memberId, role: grant.role },
      update: { role: grant.role },
    });
  }
  await deps.audit.recordInTx(tx, {
    organizationId,
    projectId: null,
    actor: { kind: "member", id: memberId },
    action: "invitation.accepted",
    entity: "invitation",
    entityId: null,
    data: { invitation: invitationHandleOf(row.id), memberId, state: membership.state },
  });
  if (membership.state === "pending_verification") {
    await deps.jobs.enqueueInTx(tx, "account-mail.send", { organizationId, purpose: "email_verification", recordId: memberId });
  }
  await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberId });
  return { ok: true as const, memberId, state: membership.state === "active" ? "active" : "pending_verification" };
};

acceptInvitation satisfies AcceptInvitation;

/**
 * The address was verified (better-auth's verify-email callback): every membership of the account
 * still waiting on it becomes active, each with its `member.verified` entry. A membership already
 * active, or removed, is left alone.
 */
export const activateVerifiedMemberships = async (
  deps: Pick<M4Deps, "audit" | "notices" | "clock">,
  tx: Tx,
  userId: UserId,
): Promise<readonly { readonly memberId: MemberId; readonly organizationId: OrganizationId }[]> => {
  const waiting = await tx.member.findMany({ where: { userId, state: "pending_verification" }, select: { id: true, organizationId: true } });
  const activated: { readonly memberId: MemberId; readonly organizationId: OrganizationId }[] = [];
  for (const row of waiting) {
    const changed = await tx.member.updateMany({ where: { id: row.id, state: "pending_verification" }, data: { state: "active" } });
    if (changed.count !== 1) {
      continue;
    }
    const memberId = memberIdSchema.parse(row.id);
    const organizationId = organizationIdSchema.parse(row.organizationId);
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: memberId },
      action: "member.verified",
      entity: "member",
      entityId: memberId,
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberId });
    activated.push({ memberId, organizationId });
  }
  return activated;
};

/** The `invitation.expire` sweep: pending invitations past their expiry are marked `expired`. */
export const expireInvitations = async (deps: Pick<M4Deps, "db" | "clock">): Promise<{ readonly expired: number }> => {
  const now = new Date(deps.clock.now());
  const changed = await deps.db.invitation.updateMany({
    where: { status: "pending", acceptedAt: null, revokedAt: null, expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  return { expired: changed.count };
};
