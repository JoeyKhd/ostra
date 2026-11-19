import type { Tx } from "@ostra/db";
import { memberIdSchema, organizationIdSchema, projectIdSchema, runnerIdSchema, sessionIdSchema, taskIdSchema, userIdSchema } from "@ostra/protocol";
import type { MemberId, OrganizationId, ProjectId, UserId } from "@ostra/protocol";
import { z } from "zod";

import { requireInstanceAdmin, requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import type { AccountScope, MemberScope, OrganizationRole } from "../access.ts";
import type { M4Deps } from "./m4-signatures.ts";
import type { GrantInstanceAdmin, RemoveMember, SetProjectAccess, SetProjectMember } from "./m4-signatures.ts";
import type { UseCaseResult } from "./common.ts";
import { handDriverItemsToProjectInTx } from "./needs-you-items.ts";
import { revokeRunner } from "./revoke-runner.ts";
import { appendServerEvent } from "./server-events.ts";

// F-002, F-003, F-087 (ADR 0053, ADR 0026; tickets 23 and 43): a membership's role and removal, a
// project's access and its listed members, and the instance admin role. Each is one transaction with
// its audit entry and its change notice. The last organization admin, and the last instance admin,
// are counted under a row lock, so two changes at once can never leave none.

/** What these use cases write through: no adapter, no queue. */
export type MembersDeps = Pick<M4Deps, "db" | "notices" | "audit" | "clock">;

const fail = <E extends string>(error: E, message: string) => ({ ok: false as const, error, message });

const lockedIdsSchema = z.array(z.looseObject({ id: z.string() }));

/** The organization's active admins, locked: what the last-admin rule counts. */
const lockActiveAdmins = async (tx: Tx, organizationId: OrganizationId): Promise<ReadonlySet<string>> => {
  const rows: unknown = await tx.$queryRaw`
    SELECT "id" FROM "member"
    WHERE "organizationId" = ${organizationId} AND "role" = 'admin' AND "state" = 'active'
    ORDER BY "id" FOR UPDATE`;
  return new Set(lockedIdsSchema.parse(rows).map((row) => row.id));
};

const isAdminRole = (role: string): boolean => role.split(",").some((part) => part.trim() === "admin");

// ---------- the organization's role ----------

export type SetMemberRole = (
  deps: MembersDeps,
  scope: MemberScope,
  input: { readonly memberId: MemberId; readonly role: OrganizationRole },
) => Promise<UseCaseResult<{ readonly role: OrganizationRole }, "forbidden" | "not-found" | "last-admin">>;

/** Changes a member's role (milestone 1's, moved to the Members page): the last active admin stays one. */
export const setMemberRole: SetMemberRole = async (deps, scope, input) => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return fail("forbidden", "Only an organization admin may change roles");
  }
  return deps.db.$transaction(async (tx) => {
    const admins = await lockActiveAdmins(tx, organizationId);
    if (!admins.has(scope.memberId)) {
      return fail("forbidden", "Only an organization admin may change roles");
    }
    const target = await tx.member.findFirst({ where: { id: input.memberId, organizationId, state: { not: "removed" } }, select: { id: true, role: true } });
    if (target === null) {
      return fail("not-found", "No such member");
    }
    if (isAdminRole(target.role) && input.role !== "admin" && admins.has(target.id) && admins.size <= 1) {
      return fail("last-admin", "An organization needs at least one admin");
    }
    await tx.member.update({ where: { id: target.id }, data: { role: input.role } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "member.role-changed",
      entity: "member",
      entityId: input.memberId,
      data: { role: input.role },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: input.memberId });
    return { ok: true as const, role: input.role };
  });
};

// ---------- removing a member (Q191) ----------

/** What a removal ended, for its audit entry and the panel's words. */
export type RemovalCounts = {
  readonly projectRoles: number;
  readonly runnersRevoked: number;
  readonly cliSessionsRevoked: number;
  readonly tasksUndriven: number;
  readonly draftsDeleted: number;
  readonly invitationsRevoked: number;
};

/**
 * Removes a membership (ADR 0053, Q191), in one transaction: marked removed and kept, so history keeps
 * its name; its project roles dropped; its personal runners in the organization revoked (F-014's
 * revoke); its CLI sessions revoked; each task it drives handed to nobody (`driver.changed`, its
 * driver's needs-you items falling back to the project's members); its draft diff comments deleted;
 * the invitations it sent and that still wait revoked; and the audit entry. An admin can't remove
 * themselves, and the last active admin can't be removed.
 */
export const removeMember = async (
  deps: MembersDeps,
  scope: MemberScope,
  input: { readonly memberId: MemberId },
): Promise<UseCaseResult<{ readonly removedAt: number; readonly counts: RemovalCounts }, "forbidden" | "not-found" | "last-admin" | "self">> => {
  const organizationId = scope.organizationId;
  if (!requireOrganizationAdmin(scope, organizationId).ok) {
    return fail("forbidden", "Only an organization admin may remove a member");
  }
  if (input.memberId === scope.memberId) {
    return fail("self", "Ask another organization admin to remove you");
  }
  const now = deps.clock.now();
  const at = new Date(now);
  return deps.db.$transaction(async (tx) => {
    const admins = await lockActiveAdmins(tx, organizationId);
    // The remover is read again under the lock: an admin removed a moment ago removes no one.
    if (!admins.has(scope.memberId)) {
      return fail("forbidden", "Only an organization admin may remove a member");
    }
    const target = await tx.member.findFirst({
      where: { id: input.memberId, organizationId, state: { not: "removed" } },
      select: { id: true, userId: true, role: true },
    });
    if (target === null) {
      return fail("not-found", "No such member");
    }
    if (admins.has(target.id) && admins.size <= 1) {
      return fail("last-admin", "An organization needs at least one admin");
    }
    const memberId = memberIdSchema.parse(target.id);

    await tx.member.update({ where: { id: target.id }, data: { state: "removed", removedAt: at, removedByMemberId: scope.memberId } });
    const projectRoles = await tx.projectMember.deleteMany({ where: { organizationId, memberId: target.id } });

    // Personal runners: milestone 2's revoke, as the remover (an admin may revoke any runner).
    const runners = await tx.runner.findMany({
      where: { organizationId, kind: "personal", ownerMemberId: target.id, revokedAt: null, state: { not: "revoked" } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    let runnersRevoked = 0;
    for (const runner of runners) {
      const revoked = await revokeRunner({ tx, scope, notices: deps.notices, audit: deps.audit, clock: deps.clock }, { runnerId: runnerIdSchema.parse(runner.id) });
      if (revoked.ok && !revoked.alreadyRevoked) {
        runnersRevoked += 1;
      }
    }

    const cliSessions = await tx.cliSession.updateMany({ where: { organizationId, memberId: target.id, revokedAt: null }, data: { revokedAt: at } });

    // The tasks it drives: driven by nobody from now, and their driver's items go to the project's members.
    const driven = await tx.task.findMany({ where: { organizationId, driverMemberId: target.id }, select: { id: true }, orderBy: { id: "asc" } });
    for (const { id } of driven) {
      await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;
      const task = await tx.task.findFirst({ where: { id, organizationId, driverMemberId: target.id }, select: { id: true, projectId: true } });
      if (task === null) {
        continue;
      }
      const taskId = taskIdSchema.parse(task.id);
      const projectId = projectIdSchema.parse(task.projectId);
      await tx.task.update({ where: { id: task.id }, data: { driverMemberId: null } });
      await handDriverItemsToProjectInTx(tx, task.id);
      const session = await tx.session.findFirst({ where: { taskId: task.id }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (session !== null) {
        await appendServerEvent(tx, {
          organizationId,
          projectId,
          taskId,
          sessionId: sessionIdSchema.parse(session.id),
          at: now,
          event: { kind: "driver.changed", memberId: null, byMemberId: scope.memberId },
        });
      }
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "task.driver-changed",
        entity: "task",
        entityId: taskId,
        data: { to: null, removedMemberId: memberId },
      });
      await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "task", entityId: taskId });
    }

    const drafts = await tx.diffComment.updateMany({ where: { organizationId, memberId: target.id, state: "draft" }, data: { state: "deleted", updatedAt: at } });

    const invitations = await tx.invitation.updateMany({
      where: { organizationId, inviterId: target.userId, status: "pending", acceptedAt: null, revokedAt: null },
      data: { status: "canceled", revokedAt: at, revokedByMemberId: scope.memberId },
    });

    const counts: RemovalCounts = {
      projectRoles: projectRoles.count,
      runnersRevoked,
      cliSessionsRevoked: cliSessions.count,
      tasksUndriven: driven.length,
      draftsDeleted: drafts.count,
      invitationsRevoked: invitations.count,
    };
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "member.removed",
      entity: "member",
      entityId: memberId,
      data: { ...counts },
    });
    // The member's own notice: an open stream of theirs looks at its access again at once.
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: memberId });
    return { ok: true as const, removedAt: now, counts };
  });
};

removeMember satisfies RemoveMember;

// ---------- a project's access and its listed members (F-087) ----------

const loadProjectForAdmin = async (tx: Tx, scope: MemberScope, projectId: ProjectId) => {
  const row = await tx.project.findFirst({ where: { id: projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
  if (row === null) {
    return fail("not-found", "No such project");
  }
  const checked = requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: row.access }, "admin");
  if (!checked.ok) {
    return checked.code === "not-found" ? fail("not-found", "No such project") : fail("forbidden", "Only a project admin may do this");
  }
  return { ok: true as const, access: row.access };
};

/**
 * Opens or restricts a project (project admin). Restricting keeps its listed members and lists the
 * member who restricts it as a project admin, so it never ends up with nobody on it.
 */
export const setProjectAccess = async (
  deps: MembersDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly access: "open" | "restricted" },
): ReturnType<SetProjectAccess> => {
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${input.projectId} AND "organizationId" = ${organizationId} FOR UPDATE`;
    const project = await loadProjectForAdmin(tx, scope, input.projectId);
    if (!project.ok) {
      return project;
    }
    if (project.access === input.access) {
      return { ok: true as const, access: input.access };
    }
    await tx.project.update({ where: { id: input.projectId }, data: { access: input.access } });
    if (input.access === "restricted") {
      await tx.projectMember.upsert({
        where: { projectId_memberId: { projectId: input.projectId, memberId: scope.memberId } },
        create: { organizationId, projectId: input.projectId, memberId: scope.memberId, role: "admin" },
        update: { role: "admin" },
      });
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.access-changed",
      entity: "project",
      entityId: input.projectId,
      data: { access: input.access },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "project", entityId: input.projectId });
    return { ok: true as const, access: input.access };
  });
};

setProjectAccess satisfies SetProjectAccess;

/**
 * Lists an existing active member on a project with a role, changes it, or (`role: null`) takes them
 * off (project admin). A project admin never invites: an address that isn't a member is an
 * organization admin's invitation (Q192).
 */
export const setProjectMember = async (
  deps: MembersDeps,
  scope: MemberScope,
  input: { readonly projectId: ProjectId; readonly memberId: MemberId; readonly role: "admin" | "member" | null },
): ReturnType<SetProjectMember> => {
  const organizationId = scope.organizationId;
  return deps.db.$transaction(async (tx) => {
    const project = await loadProjectForAdmin(tx, scope, input.projectId);
    if (!project.ok) {
      return project;
    }
    const member = await tx.member.findFirst({ where: { id: input.memberId, organizationId, state: "active" }, select: { id: true } });
    if (member === null) {
      return fail("not-a-member", "Only a member of the organization can be listed on a project");
    }
    if (input.role === null) {
      await tx.projectMember.deleteMany({ where: { projectId: input.projectId, memberId: input.memberId } });
    } else {
      await tx.projectMember.upsert({
        where: { projectId_memberId: { projectId: input.projectId, memberId: input.memberId } },
        create: { organizationId, projectId: input.projectId, memberId: input.memberId, role: input.role },
        update: { role: input.role },
      });
    }
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: input.projectId,
      actor: { kind: "member", id: scope.memberId },
      action: input.role === null ? "project.member-removed" : "project.member-set",
      entity: "project",
      entityId: input.projectId,
      data: input.role === null ? { memberId: input.memberId } : { memberId: input.memberId, role: input.role },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "project", entityId: input.projectId });
    // The member's own notice: their open stream looks at its access again at once.
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "member", entityId: input.memberId });
    return { ok: true as const, role: input.role };
  });
};

setProjectMember satisfies SetProjectMember;

// ---------- the instance admin role (F-003, ticket 43) ----------

/** The value `user.role` holds for an account that isn't the instance admin (better-auth's admin plugin). */
const PLAIN_ACCOUNT_ROLE = "user";

/**
 * Makes an account an instance admin, or takes the role back (instance admin only). The install's
 * instance admins are counted under a row lock, so the last one can't give the role up even when two
 * revokes run at once (ADR 0053, Q194). The entry goes to each organization the actor or the account
 * is an active member of.
 */
export const grantInstanceAdmin = async (
  deps: MembersDeps,
  account: AccountScope,
  input: { readonly userId: UserId; readonly grant: boolean },
): ReturnType<GrantInstanceAdmin> => {
  if (!requireInstanceAdmin(account).ok) {
    return fail("forbidden", "Only an instance admin may do this");
  }
  return deps.db.$transaction(async (tx) => {
    const rows: unknown = await tx.$queryRaw`SELECT "id" FROM "user" WHERE "role" = 'admin' ORDER BY "id" FOR UPDATE`;
    const admins = new Set(lockedIdsSchema.parse(rows).map((row) => row.id));
    // The actor is read again under the lock: an admin whose role went a moment ago grants nothing.
    if (!admins.has(account.userId)) {
      return fail("forbidden", "Only an instance admin may do this");
    }
    const target = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (target === null) {
      return fail("not-found", "No such account");
    }
    const isAdmin = admins.has(target.id);
    if (isAdmin === input.grant) {
      return { ok: true as const, instanceAdmin: isAdmin };
    }
    if (!input.grant && admins.size <= 1) {
      return fail("last-instance-admin", "An install needs at least one instance admin");
    }
    await tx.user.update({ where: { id: target.id }, data: { role: input.grant ? "admin" : PLAIN_ACCOUNT_ROLE } });
    const memberships = await tx.member.findMany({
      where: { userId: { in: [account.userId, target.id] }, state: "active" },
      select: { id: true, userId: true, organizationId: true },
      orderBy: { createdAt: "asc" },
    });
    const organizations = [...new Set(memberships.map((row) => row.organizationId))];
    for (const organizationId of organizations) {
      const actor = memberships.find((row) => row.organizationId === organizationId && row.userId === account.userId);
      await deps.audit.recordInTx(tx, {
        organizationId: organizationIdSchema.parse(organizationId),
        projectId: null,
        actor: actor === undefined ? { kind: "system", id: null } : { kind: "member", id: actor.id },
        action: input.grant ? "instance.admin-granted" : "instance.admin-revoked",
        entity: "user",
        entityId: userIdSchema.parse(target.id),
      });
    }
    return { ok: true as const, instanceAdmin: input.grant };
  });
};

grantInstanceAdmin satisfies GrantInstanceAdmin;
