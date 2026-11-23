# 01: DB: the milestone 11 migration

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-152, F-008
Packages: `packages/db` (`prisma/schema.prisma`, a new migration, `src/enums.ts`, the migration test)
Spec: `../spec.md`, section 5.1; ADR 0071

## What to build

One migration after `20261203110000_box_released_with_its_session`, as section 5.1's table says:

- **Enums:** `ConnectionKind` + `jira`; `ConnectionCredential` + `service_account_token`. `src/enums.ts`'s mappings gain them, with exhaustive `switch`es in every caller (`apps/core/src/tracker/connections.ts`'s `build` answers `null` for `jira` until ticket 07 builds the adapter).
- **`Connection`:** + `name`, `accountEmail`, `tokenExpiresOn` (`@db.Date`), `accessCheck` (JSON), `accessCheckedAt`, `firstDeliveryAt`, `badSignatureAt`, `resumedIntoId`, each nullable, each with its `///` doc line saying what it holds and that no secret is in it.
- **Indexes:** add `connection_one_site_per_organization`; drop `connection_one_linear_per_organization`. `Board`: add `(projectId, connectionId, externalId)`; drop `(projectId, externalId)`. Every `findUnique` on the old board key changes to the new one in the same commit (grep `projectId_externalId`).
- **`TicketWrite`:** + `via` (JSON, null). **`OrganizationSetting`:** + `trackerSkippedAt`.
- **Data, in the same SQL:** each Linear row's `name`; a pending Linear row's `appId` `pending` → `pending:<id>`; `trackerSkippedAt` from `linearSkippedAt`.
- **The domain's placeholder check** reads both `pending` forms in the same commit (`linearAppIdPlaceholders`, one helper `isPendingAppId`), so nothing breaks before ticket 05.

## Done when

- [ ] Tests named for `F-152/c6`: the migration over a milestone 10 database (one active Linear connection with agent mode on, two boards, cached tickets, a revoked older Linear row, a skipped setup step) leaves every row readable, the Linear row named `<workspace> Linear`, the pending placeholder rewritten, `trackerSkippedAt` copied, the new indexes present and the two old ones gone (break-it: leave the one-Linear index, and inserting a second Linear connection fails the test).
- [ ] Tests named for `F-152/c2`: a second connection of one kind with the same `externalWorkspaceId` in one organization is refused by Postgres while the first isn't `revoked`, and allowed once it is; the same site in another organization is allowed.
- [ ] Tests named for `F-152/c4`: two boards with the same `externalId` under two connections attach to one project; the same connection's twice is refused.
- [ ] Milestone 4's generated isolation test passes.
- [ ] Checks for `packages/db` and its direct consumers pass, and the whole-repo checks (spec section 10).
- [ ] Committed as `✨ add milestone 11's tracker columns`.

## Comments
