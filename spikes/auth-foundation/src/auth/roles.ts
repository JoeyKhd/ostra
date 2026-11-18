import { createAccessControl } from "better-auth/plugins/access";

// ADR 0026: two roles at the organization level, admin and member. better-auth
// ships a third (owner); ostra does not register it, and the creator of an
// organization is made an admin instead (`creatorRole` in create-auth.ts).
//
// The statements are better-auth's own defaults for the organization plugin,
// repeated here so the permission names ostra relies on are visible in one file.
export const organizationStatements = {
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
  team: ["create", "update", "delete"],
  ac: ["create", "read", "update", "delete"],
} as const;

export const organizationAccessControl = createAccessControl(organizationStatements);

export const organizationRoles = {
  // An admin runs the organization but cannot delete it.
  admin: organizationAccessControl.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
    team: ["create", "update", "delete"],
    ac: ["create", "read", "update", "delete"],
  }),
  // A member manages nothing.
  member: organizationAccessControl.newRole({
    organization: [],
    member: [],
    invitation: [],
    team: [],
    ac: ["read"],
  }),
};

export const organizationRoleNames = ["admin", "member"] as const;
export type OrganizationRole = (typeof organizationRoleNames)[number];

/**
 * better-auth validates a role name against its built-in names (admin, owner,
 * member) as well as ostra's own, so leaving `owner` out of `organizationRoles`
 * does not make it unusable: an invitation for "owner" is accepted, and the
 * member ends up with a role ostra never defined. The organization hooks call
 * this to close that gap, and to keep one role per member.
 */
export const isOrganizationRole = (role: string): role is OrganizationRole =>
  organizationRoleNames.some((name) => name === role);
