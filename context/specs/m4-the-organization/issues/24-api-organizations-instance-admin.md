# 24: API: organizations and the instance admin

Status: wontfix
Note: Won't do now (2026-11-19): one team runs each install, with its clients as projects inside one organization, so v1 ships one organization per install. The lead proposed moving F-049's multi-organization features after v1, and the maintainer answered "sure". Creating, switching and resolving organizations, and the instance's list of organizations, are F-134 now. The instance admin's accounts (`instance.accounts.search`, `instance.grantAdmin`, `instance.revokeAdmin` and the last instance admin) moved to ticket 43, which v1 builds. This ticket waits for F-134 after v1, and its text stays as written for then, less what moved.
Builder: api
Blocked by: 06, 23, 43
Features: F-134 (F-049 until 2026-11-19)
Packages: `packages/api` (`src/routers/organizations.ts` (new), `src/routers/instance.ts`, `src/auth/scope.ts`), `packages/domain` (`createOrganization`, `switchOrganization`)
Spec: `../spec.md`, section 4 ("Switching organizations"); ADR 0053, ADR 0026

## What to build

- **`organizations.mine`:** the account's active memberships, with the active one marked.
- **`organizations.switch(organizationId)`:** a membership check, then the session's `activeOrganizationId` and the account's `lastOrganizationId`. A sign-in starts in the last one, or the first if it's gone.
- **`organizations.create`** (the instance admin): `createOrganization` makes the organization, its default pool and the built-in agent profile (the same code the first admin's seed uses), and the creator's admin membership, in one transaction, with an audit entry in the new organization. *Changed 2026-11-19: this said "or anyone when open organization sign-up is on". Open sign-up existed for a hosted version, which isn't planned (ADR 0026, amended). `OSTRA_OPEN_SIGNUP_ORGANIZATIONS` stays as milestone 1 built it, off by default, so this check follows it the way better-auth's own check does, and nothing more is built for it.*
- **`organizations.resolve(entity, id)`:** for a link to a record, the organization it belongs to if the caller is a member there, else `NOT_FOUND`; the panel switches with it.
- **The Organizations page's procedure** (instance admin only): `instance.organizations` (name, counts of members and projects; no content of any). `accounts.createResetLink` is ticket 22's. *Changed 2026-11-19: the two open sign-up switches are out, for the same reason. Changed again 2026-11-19: `instance.accounts.search` and `instance.grantAdmin` / `instance.revokeAdmin` moved to ticket 43.*

## Done when

- [ ] Tests named `it("F-134: ...")` (`F-049` until 2026-11-19): a created organization has its pool and profile and nothing of another's; a member of two switches between them and each list follows; a switch to an organization the account isn't in is refused; `resolve` never reveals a record of an organization the caller isn't in; with the settings at their defaults, an account that isn't an instance admin can't create one.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add several organizations`.

## Comments

- 2026-11-19, lead: set `wontfix`. Several organizations per install (F-134) moved after v1 on the maintainer's word, and this ticket waits for it. Its `F-003` tests (the last instance admin, and the instance admin seeing nothing inside an organization it isn't in) moved to ticket 43 with the procedures they cover.
