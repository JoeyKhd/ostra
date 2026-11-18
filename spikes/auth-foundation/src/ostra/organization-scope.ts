import * as z from "zod";
import type { OstraAuth } from "../auth/create-auth.ts";
import { organizationRoleNames } from "../auth/roles.ts";
import type { PrismaClient } from "../db/prisma-client.ts";
import { OrganizationId, UserId } from "../ids.ts";

// ADR 0026: "Every row carries its organization. No query crosses organizations."
//
// The way that holds in code: no ostra query takes an organization ID from the
// caller. It takes a `MemberScope`, and the only thing that makes one is
// `requireMember`, which proves from the session and the member table that the
// caller belongs to that organization.

const memberScopeSchema = z
  .object({
    userId: UserId,
    organizationId: OrganizationId,
    role: z.enum(organizationRoleNames),
  })
  .brand<"MemberScope">();

export type MemberScope = z.infer<typeof memberScopeSchema>;

export type ScopeResult =
  | { readonly ok: true; readonly scope: MemberScope }
  | { readonly ok: false; readonly reason: "unauthenticated" | "not-a-member" };

export type ScopeDeps = {
  readonly auth: OstraAuth;
  readonly prisma: PrismaClient;
};

/** better-auth stores several roles of one member as "admin,member". The highest one counts. */
const highestRole = (stored: string): (typeof organizationRoleNames)[number] =>
  stored
    .split(",")
    .map((part) => part.trim())
    .includes("admin")
    ? "admin"
    : "member";

/**
 * `requestedOrganization` is what the caller asked for (a URL segment, a header): untrusted text,
 * parsed into an `OrganizationId` here, once, so nothing past this function holds a bare string.
 */
export const requireMember = async (
  deps: ScopeDeps,
  headers: Headers,
  requestedOrganization: string,
): Promise<ScopeResult> => {
  const session = await deps.auth.api.getSession({ headers });
  if (session === null) {
    return { ok: false, reason: "unauthenticated" };
  }
  const organizationId = OrganizationId.safeParse(requestedOrganization);
  if (!organizationId.success) {
    return { ok: false, reason: "not-a-member" };
  }
  const userId = UserId.parse(session.user.id);
  const member = await deps.prisma.member.findUnique({
    where: { organizationId_userId: { organizationId: organizationId.data, userId } },
    select: { role: true },
  });
  if (member === null) {
    // The same answer for "no such organization" and "not yours": no existence oracle.
    return { ok: false, reason: "not-a-member" };
  }
  return {
    ok: true,
    scope: memberScopeSchema.parse({
      userId,
      organizationId: organizationId.data,
      role: highestRole(member.role),
    }),
  };
};
