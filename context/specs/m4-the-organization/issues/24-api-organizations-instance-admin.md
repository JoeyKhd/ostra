# 24: API: organizations and the instance admin

Status: ready-for-agent
Builder: api
Blocked by: 06, 23
Features: F-049, F-002 (the instance admin's reset), F-003 (the last instance admin)
Packages: `packages/api` (`src/routers/organizations.ts` (new), `src/routers/instance.ts` (new), `src/auth/scope.ts`), `packages/domain` (`createOrganization`, `switchOrganization`, `grantInstanceAdmin`)
Spec: `../spec.md`, section 4 ("Switching organizations"); ADR 0053, ADR 0026

## What to build

- **`organizations.mine`:** the account's active memberships, with the active one marked.
- **`organizations.switch(organizationId)`:** a membership check, then the session's `activeOrganizationId` and the account's `lastOrganizationId`. A sign-in starts in the last one, or the first if it's gone.
- **`organizations.create`** (the instance admin): `createOrganization` makes the organization, its default pool and the built-in agent profile (the same code the first admin's seed uses), and the creator's admin membership, in one transaction, with an audit entry in the new organization. *Changed 2026-11-19: this said "or anyone when open organization sign-up is on". Open sign-up existed for a hosted version, which isn't planned (ADR 0026, amended). `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` stays as milestone 1 built it, off by default, so this check follows it the way better-auth's own check does, and nothing more is built for it.*
- **`organizations.resolve(entity, id)`:** for a link to a record, the organization it belongs to if the caller is a member there, else `NOT_FOUND`; the panel switches with it.
- **The instance pages' procedures** (instance admin only): `instance.organizations` (name, counts of members and projects; no content of any), `instance.accounts.search` (by username or address), `instance.grantAdmin` / `instance.revokeAdmin` (the last instance admin refused). `accounts.createResetLink` is ticket 22's. *Changed 2026-11-19: the two open sign-up switches are out, for the same reason.*

## Done when

- [ ] Tests named `it("F-049: ...")`: a created organization has its pool and profile and nothing of another's; a member of two switches between them and each list follows; a switch to an organization the account isn't in is refused; `resolve` never reveals a record of an organization the caller isn't in; with the settings at their defaults, an account that isn't an instance admin can't create one.
- [ ] Tests named `it("F-003: ...")`: the last instance admin can't revoke the role; the instance admin sees no project or task of an organization it isn't a member of.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add several organizations`.

## Comments
