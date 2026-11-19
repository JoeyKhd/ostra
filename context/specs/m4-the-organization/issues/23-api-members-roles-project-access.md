# 23: API: members, roles and project access

Status: ready-for-agent
Builder: api
Blocked by: 06, 10
Features: F-003, F-087, F-002 (removal)
Packages: `packages/api` (`src/routers/organization.ts`, `src/routers/members.ts`, `src/routers/projects.ts`, `src/trpc/init.ts`, `src/auth/scope.ts`), `packages/domain` (`removeMember`, `setProjectAccess`, `setProjectMember`)
Spec: `../spec.md`, section 4 ("Removing a member"); ADR 0053, ADR 0026

## What to build

- **`members.list`:** active members (with role, restricted projects, last active), and removed ones on request; addresses for admins only, as `organization.members` does now (which it replaces or wraps; say which in `## Comments`).
- **`members.setRole`:** milestone 1's `setMemberRole` with its lock, moved here.
- **`members.remove`** (organization admin): ADR 0053's transaction through `removeMember`: the membership marked removed, project roles dropped, personal runners revoked (milestone 2's revoke), CLI sessions revoked, a `driver.changed` to nobody on each task they drive, their draft diff comments deleted, their pending invitations revoked, the audit entry. The last admin can't be removed or leave. better-auth's `removeMember`, `leaveOrganization` and their endpoints are refused by ostra's hooks.
- **The scope:** a removed or pending membership makes no `MemberScope`, so every procedure and the live stream refuse it at once; the stream ends the member's open subscriptions in that organization.
- **Project access:** `projects.setAccess` (project admin: open or restricted) and `projects.setMember` / `projects.removeMember` (project admin: an existing active member, with a role), each an audit entry. Restricting a project keeps its project admins listed and lists the member who restricts it.
- **The matrix:** every procedure's guard checked against ADR 0026's matrix, through `requireProjectAccess`; a refusal of a project the member can't open is `NOT_FOUND`.

## Done when

- [ ] Tests named `it("F-003: ...")` and `it("F-087: ...")`: the matrix table of ticket 09 for these procedures; the last-admin race (two removals at once leave one admin); a project member can't edit the environment and a project admin can; restricting a project hides its records from an unlisted member at once.
- [ ] Tests named `it("F-002: ...")` for removal: each effect of the transaction; a removed member's next call is refused; history shows "(removed)".
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add members, roles and project access`.

## Comments
