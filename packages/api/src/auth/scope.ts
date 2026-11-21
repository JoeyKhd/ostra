import { themeFromCookie } from "@ostra/domain";
import type { MemberScope, ProjectRole, ThemePreference } from "@ostra/domain";
import type { Db } from "@ostra/db";
import { loginSessionIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, userIdSchema } from "@ostra/protocol";
import type { LoginSessionId, MemberId, OrganizationId, ProjectId, UserId } from "@ostra/protocol";

import { mustChangePasswordOf } from "./create-auth.ts";
import type { OstraAuth } from "./create-auth.ts";
import { highestRole } from "./roles.ts";

// Ported from spikes/auth-foundation/src/ostra/organization-scope.ts (ADR 0026).
//
// "Every row carries its organization. No query crosses organizations." The way that holds in code:
// no ostra query takes an organization ID from the caller. It takes a `MemberScope`, and the only
// things that make one are the functions here, which prove from the session and the member table
// that the caller belongs to that organization.

/** The ID of a login session: better-auth's, apart from the `SessionId` of an agent session (the protocol's, so the domain names it too). */
export { loginSessionIdSchema };
export type { LoginSessionId };

/** Who is signed in, as better-auth resolved their session. */
export type SessionUser = {
  /** The login session's own ID (not its token, which is never read): what a one-time value binds to. */
  readonly sessionId: LoginSessionId;
  readonly userId: UserId;
  readonly name: string;
  readonly username: string | null;
  readonly email: string;
  /** The instance admin (Q102), apart from an organization role. */
  readonly instanceAdmin: boolean;
  /** The organization the session says it is in, if any. Untrusted until `loadMemberScope`. */
  readonly sessionOrganizationId: string | null;
  /** The account still has the default password it was seeded with (F-001). */
  readonly mustChangePassword: boolean;
  /** F-082: the member's theme, as the session carries it. */
  readonly theme: ThemePreference;
};

/** A signed-in account's membership of one organization, with the scope every query takes. */
export type MemberContext = {
  readonly scope: MemberScope;
  readonly userId: UserId;
};

/** The theme a session's user carries, or dark for none it knows (F-082). */
const themeOf = (user: object): ThemePreference => {
  const theme: unknown = Reflect.get(user, "theme");
  return themeFromCookie(typeof theme === "string" ? theme : undefined);
};

/** The session behind a request's cookie or bearer token, or `null`. */
export const resolveSession = async (auth: OstraAuth, headers: Headers): Promise<SessionUser | null> => {
  const found = await auth.api.getSession({ headers });
  if (found === null) {
    return null;
  }
  const { user, session } = found;
  const active: unknown = Reflect.get(session, "activeOrganizationId");
  const role: unknown = Reflect.get(user, "role");
  const username: unknown = Reflect.get(user, "username");
  return {
    sessionId: loginSessionIdSchema.parse(session.id),
    userId: userIdSchema.parse(user.id),
    name: user.name,
    username: typeof username === "string" ? username : null,
    email: user.email,
    instanceAdmin: role === "admin",
    sessionOrganizationId: typeof active === "string" && active !== "" ? active : null,
    mustChangePassword: mustChangePasswordOf(user),
    theme: themeOf(user),
  };
};

/**
 * The member this account is in the session's organization (or, when the session names none, its
 * oldest organization), with their project roles. `null` when the account belongs to no
 * organization. The organization ID is read from the member row, never from the caller.
 *
 * Only an active membership makes a scope (ADR 0053): a removed one, or one still waiting on its
 * address's verification, is as if the account weren't a member, so every procedure and the live
 * stream refuse it at once.
 */
export const loadMemberContext = async (db: Db, user: SessionUser): Promise<MemberContext | null> => {
  const member =
    (user.sessionOrganizationId === null
      ? null
      : await db.member.findFirst({
          where: { organizationId: user.sessionOrganizationId, userId: user.userId, state: "active" },
        })) ?? (await db.member.findFirst({ where: { userId: user.userId, state: "active" }, orderBy: { createdAt: "asc" } }));
  if (member === null) {
    return null;
  }
  return memberContextOf(db, user.userId, member);
};

/** A membership of an account as the scope every query takes, with its project roles. */
export const memberContextOf = async (
  db: Db,
  userId: UserId,
  member: { readonly id: string; readonly organizationId: string; readonly role: string },
): Promise<MemberContext> => {
  const organizationId: OrganizationId = organizationIdSchema.parse(member.organizationId);
  const memberId: MemberId = memberIdSchema.parse(member.id);
  const listed = await db.projectMember.findMany({
    where: { organizationId, memberId },
    select: { projectId: true, role: true },
  });
  const projectRoles = new Map<ProjectId, ProjectRole>(
    listed.map((row) => [projectIdSchema.parse(row.projectId), row.role] as const),
  );
  return {
    userId,
    scope: { organizationId, memberId, role: highestRole(member.role), projectRoles },
  };
};
