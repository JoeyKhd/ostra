import type { MemberId, OrganizationId, ProjectId } from "@ostra/protocol";

// The access checks (ADR 0026): every tRPC procedure and the live stream call these on the member's
// scope before reading or writing. Pure: the scope is loaded once per request.
//
// - Another organization's record is `not-found`, never `forbidden`: its existence doesn't leak.
// - A restricted project is visible only to its listed members and the organization's admins; to
//   anyone else it is `not-found` too.

export type OrganizationRole = "admin" | "member";
export type ProjectRole = "admin" | "member";

/** Who is asking: one member of one organization, with their roles. */
export type MemberScope = {
  readonly organizationId: OrganizationId;
  readonly memberId: MemberId;
  readonly role: OrganizationRole;
  /** Their role on each restricted project they're listed on. */
  readonly projectRoles: ReadonlyMap<ProjectId, ProjectRole>;
};

/** What the checks need to know about a project. */
export type ProjectAccessInfo = {
  readonly id: ProjectId;
  readonly organizationId: OrganizationId;
  readonly access: "open" | "restricted";
};

export type AccessDenied = { readonly ok: false; readonly code: "not-found" | "forbidden" };
export type AccessGranted<T> = { readonly ok: true; readonly value: T };
export type Access<T> = AccessGranted<T> | AccessDenied;

const granted = <T>(value: T): AccessGranted<T> => ({ ok: true, value });
const notFound: AccessDenied = { ok: false, code: "not-found" };
const forbidden: AccessDenied = { ok: false, code: "forbidden" };

export const requireOrganizationMember = (scope: MemberScope, organizationId: OrganizationId): Access<MemberScope> =>
  scope.organizationId === organizationId ? granted(scope) : notFound;

export const requireOrganizationAdmin = (scope: MemberScope, organizationId: OrganizationId): Access<MemberScope> => {
  if (scope.organizationId !== organizationId) {
    return notFound;
  }
  return scope.role === "admin" ? granted(scope) : forbidden;
};

/**
 * `read`: see the project and its tasks, and start tasks in it (any member who can open it).
 * `admin`: change its settings, repos and environment.
 */
export type ProjectNeed = "read" | "admin";

export const requireProjectAccess = (
  scope: MemberScope,
  project: ProjectAccessInfo,
  need: ProjectNeed,
): Access<{ readonly scope: MemberScope; readonly project: ProjectAccessInfo; readonly role: ProjectRole }> => {
  if (scope.organizationId !== project.organizationId) {
    return notFound;
  }
  const listed = scope.projectRoles.get(project.id);
  let role: ProjectRole | undefined;
  if (scope.role === "admin") {
    role = "admin";
  } else if (project.access === "open") {
    role = listed ?? "member";
  } else {
    role = listed;
  }
  if (role === undefined) {
    return notFound;
  }
  switch (need) {
    case "read":
      return granted({ scope, project, role });
    case "admin":
      return role === "admin" ? granted({ scope, project, role }) : forbidden;
    default:
      return need satisfies never;
  }
};

/** The projects a member can see, for list queries: filters by organization and restriction. */
export const visibleProjects = <P extends ProjectAccessInfo>(scope: MemberScope, projects: readonly P[]): readonly P[] =>
  projects.filter((project) => requireProjectAccess(scope, project, "read").ok);
