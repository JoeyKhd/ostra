# 23: API: members, roles and project access

Status: resolved
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

- [x] Tests named `it("F-003: ...")` and `it("F-087: ...")`: the matrix table of ticket 09 for these procedures; the last-admin race (two removals at once leave one admin); a project member can't edit the environment and a project admin can; restricting a project hides its records from an unlisted member at once.
- [x] Tests named `it("F-002: ...")` for removal: each effect of the transaction; a removed member's next call is refused; history shows "(removed)".
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add members, roles and project access`.

## Comments

- 2026-11-19: `members.list` (active and waiting members, removed ones with `includeRemoved`, addresses for admins only, restricted projects as far as the caller can open them, last activity), `members.setRole` and `members.remove` (`packages/api/src/routers/members.ts`), and `projects.access`, `projects.setAccess`, `projects.setMember` and `projects.removeMember`. The use cases are `packages/domain/src/use-cases/members.ts`: `setMemberRole`, `removeMember` (ADR 0053's transaction: the membership marked removed, project roles, personal runners through milestone 2's `revokeRunner`, CLI sessions, each driven task to nobody with a `driver.changed` and its driver's needs-you items to the project's members, drafts deleted, the invitations the member sent revoked, `member.removed`), `setProjectAccess` and `setProjectMember`. The active admins are counted under `FOR UPDATE`, and the remover is read again under the lock. `organization.members` now wraps `members.list` with removed members included and `(removed)` after their name, so a task's history keeps its names; it gains `state`, and the agent profile editor leaves removed members out. `organization.setMemberRole` calls the same use case. Protocol: `driver.changed`'s `memberId` may be `null` (nobody drives), an additive change in its own commit, with its words in the panel. The live stream looks again at once on a notice about the member or a project, so a removed member's streams end and a restricted project's tasks stop at once. Tests: `packages/api/src/routers/members.test.ts` (10, the matrix over tickets 22, 23 and 25's procedures included; ticket 43 adds its own rows), and four new cases in `every-action.test.ts` (ticket 22 added two and ticket 43 adds two); break-its in `context/proof/F-002.md`, `F-003.md` and `F-087.md`. Committed as `✨ add members, roles and project access`. The protocol's nullable `driver.changed` went first, on its own, as `✨ let a task be driven by nobody`.
