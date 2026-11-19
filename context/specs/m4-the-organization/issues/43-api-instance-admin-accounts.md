# 43: API: the instance admin's accounts

Status: resolved
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

- [x] Tests named `it("F-003: ...")`: the last instance admin can't revoke the role, and two revokes at once leave one; an account that isn't the instance admin is refused every `instance.*` procedure; the instance admin sees no project or task of an organization it isn't a member of (a second organization from ticket 09's fixtures).
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the instance admin's accounts`.

## Comments

- 2026-11-19: `instance.accounts.search`, `instance.grantAdmin` and `instance.revokeAdmin` (`packages/api/src/routers/instance.ts`), through `grantInstanceAdmin` (`packages/domain/src/use-cases/members.ts`): the install's instance admins are counted under `FOR UPDATE`, the actor is read again under the lock, and the entry goes to each organization the actor or the account is an active member of. A plain account's `user.role` is `user`. The search is a case-insensitive prefix of the username, the address or the name, sorted by name and ID, 50 a page with a keyset cursor; `instanceAdminSince` is the newest `instance.admin-granted` entry's time, or the account's creation for the first admin. Tests: `packages/api/src/routers/instance.test.ts` (4; the race runs five rounds, since one round let a lockless break through once), break-its in `context/proof/F-003.md`. It also adds the three `instance.*` rows to ticket 23's access matrix, and the `instance.admin-granted` and `instance.admin-revoked` cases to `every-action.test.ts`. Committed as `✨ add the instance admin's accounts`.
