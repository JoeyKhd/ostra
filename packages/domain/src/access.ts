import type { MemberId, OrganizationId, ProjectId, UserId } from "@ostra/protocol";

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

// ---------- milestone 4 (ADR 0053, ADR 0044 amended, ADR 0054) ----------

/** A membership's state (ADR 0053). Only an active one makes a scope. */
export type MembershipState = "active" | "pending_verification" | "removed";

/**
 * The scope a membership makes, or `null`: a removed or pending membership sees nothing of the
 * organization, as if it weren't a member (ADR 0053).
 */
export const scopeForMembership = (
  membership: { readonly organizationId: OrganizationId; readonly memberId: MemberId; readonly role: OrganizationRole; readonly state: MembershipState },
  projectRoles: ReadonlyMap<ProjectId, ProjectRole>,
): MemberScope | null => {
  switch (membership.state) {
    case "active":
      return { organizationId: membership.organizationId, memberId: membership.memberId, role: membership.role, projectRoles };
    case "pending_verification":
    case "removed":
      return null;
    default:
      return membership.state satisfies never;
  }
};

/** Who is asking at the install's level: an account, and whether it's an instance admin. */
export type AccountScope = { readonly userId: UserId; readonly instanceAdmin: boolean };

/** The instance admin's pages (ADR 0053). The role grants nothing inside an organization the account isn't in. */
export const requireInstanceAdmin = (account: AccountScope): Access<AccountScope> => (account.instanceAdmin ? granted(account) : forbidden);

/** What the memory checks need to know about a note. */
export type NoteAccessInfo = {
  readonly organizationId: OrganizationId;
  /** `null` for an organization note. */
  readonly project: ProjectAccessInfo | null;
  readonly authorMemberId: MemberId | null;
};

/**
 * Who writes, edits and approves memory (ADR 0044, Q201): any member who can open the project, for
 * its notes; any member of the organization, for organization notes.
 */
export const canWriteNote = (scope: MemberScope, note: NoteAccessInfo): boolean => {
  if (scope.organizationId !== note.organizationId) {
    return false;
  }
  return note.project === null || requireProjectAccess(scope, note.project, "read").ok;
};

/**
 * Archiving or deleting a note: its author, if they can still write it; anyone else's needs a
 * project admin, or an organization admin for an organization note (ADR 0044, Q201).
 */
export const canArchiveNote = (scope: MemberScope, note: NoteAccessInfo): boolean => {
  if (!canWriteNote(scope, note)) {
    return false;
  }
  if (note.authorMemberId !== null && note.authorMemberId === scope.memberId) {
    return true;
  }
  return note.project === null ? scope.role === "admin" : requireProjectAccess(scope, note.project, "admin").ok;
};

/**
 * The audit log (ADR 0054, Q197): organization admins read all of it; a project admin reads their
 * project's entries. `project` is `null` for the organization-wide log.
 */
export const canReadAudit = (scope: MemberScope, organizationId: OrganizationId, project: ProjectAccessInfo | null): boolean => {
  if (scope.organizationId !== organizationId) {
    return false;
  }
  if (scope.role === "admin") {
    return true;
  }
  return project !== null && requireProjectAccess(scope, project, "admin").ok;
};

// ---------- keys per project (F-135, ADR 0065) ----------

/** The default provider list, a project's mode and its own list are an organization admin's (Q270). */
export const canEditProviderLists = (scope: MemberScope, organizationId: OrganizationId): boolean =>
  requireOrganizationAdmin(scope, organizationId).ok;

/** Anyone who can open the project sees its providers by name and the model each serves, never a token. */
export const canSeeProjectProviders = (scope: MemberScope, project: ProjectAccessInfo): boolean =>
  requireProjectAccess(scope, project, "read").ok;

// ---------- milestone 4: reasoning effort (F-137, ADR 0066) ----------

/** What `canSetTaskEffort` needs to know about a task. */
export type TaskDriverInfo = {
  readonly organizationId: OrganizationId;
  readonly driverMemberId: MemberId | null;
};

/**
 * Who may change a task's reasoning level: its driver (F-024), as for a steer. Anyone else takes
 * over first. The caller has checked the project's `read` access, and reads the driver under the
 * task's counter lock.
 */
export const canSetTaskEffort = (scope: MemberScope, task: TaskDriverInfo): boolean =>
  scope.organizationId === task.organizationId && task.driverMemberId !== null && task.driverMemberId === scope.memberId;
