# 43: API: the instance admin's accounts

Status: ready-for-agent
Builder: api
Blocked by: 06, 23
Features: F-003 (the last instance admin), F-002 (the page the instance admin's reset link is made on)
Note: split from ticket 24 on 2026-11-19. One team runs each install, so v1 ships one organization per install, and ticket 24's several organizations (F-134) moved after v1 on the maintainer's word. The instance admin's accounts stay in v1, here.
Packages: `packages/api` (`src/routers/instance.ts` (new), `src/auth/scope.ts`), `packages/domain` (`grantInstanceAdmin`)
Spec: `../spec.md`, sections 3 (step 12) and 12 (target `instance-settings`, page 2); ADR 0053 ("Roles, and the last admin"), ADR 0026

## What to build

- **`instance.accounts.search`** (instance admin only): accounts by a prefix of the username, the address or the name, case-insensitive, sorted by name, 50 at a time with keyset pagination. Each with what the Accounts page shows (`instance-settings.md`, "Data these pages need"): its name, username, address and whether it's verified, its active organizations' names, when it was created, its last sign-in, and whether it's an instance admin, with the grant's time. Nothing of any organization's content.
- **`instance.grantAdmin` / `instance.revokeAdmin`** (instance admin only), through `grantInstanceAdmin`: each an audit entry, by ID. The last instance admin can't revoke the role, checked under a row lock, so two revokes at once leave one (ADR 0053, Q194).
- **The guard:** every `instance.*` procedure refuses an account that isn't the instance admin. The role grants nothing inside an organization the account isn't a member of, so no `instance.*` answer carries a project, task or note.
- `accounts.createResetLink` is ticket 22's. The instance's list of organizations (`instance.organizations`) waits with ticket 24 for F-134.

## Done when

- [ ] Tests named `it("F-003: ...")`: the last instance admin can't revoke the role, and two revokes at once leave one; an account that isn't the instance admin is refused every `instance.*` procedure; the instance admin sees no project or task of an organization it isn't a member of (a second organization from ticket 09's fixtures).
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the instance admin's accounts`.

## Comments
