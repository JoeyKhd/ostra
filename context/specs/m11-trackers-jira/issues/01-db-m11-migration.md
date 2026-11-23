# 01: DB: the milestone 11 migration

Status: done
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

- [x] Tests named for `F-152/c6`: the migration over a milestone 10 database (one active Linear connection with agent mode on, two boards, cached tickets, a revoked older Linear row, a skipped setup step) leaves every row readable, the Linear row named `<workspace> Linear`, the pending placeholder rewritten, `trackerSkippedAt` copied, the new indexes present and the two old ones gone (break-it: leave the one-Linear index, and inserting a second Linear connection fails the test).
- [x] Tests named for `F-152/c2`: a second connection of one kind with the same `externalWorkspaceId` in one organization is refused by Postgres while the first isn't `revoked`, and allowed once it is; the same site in another organization is allowed.
- [x] Tests named for `F-152/c4`: two boards with the same `externalId` under two connections attach to one project; the same connection's twice is refused.
- [x] Milestone 4's generated isolation test passes.
- [x] Checks for `packages/db` and its direct consumers pass, and the whole-repo checks (spec section 10).
- [x] Committed as `✨ add milestone 11's tracker columns`.

## Comments

- 2026-11-23, core: built as `✨ add milestone 11's tracker columns`. Migration `20261204000000_milestone_11`; tests in `packages/db/src/schema-m11.test.ts` (`F-152/c6` twice, `F-152/c2`, `F-152/c4`, and the schema-matches-migrations diff) and `packages/domain/src/tickets/contracts.test.ts` (`isPendingAppId`). Readings and differences:
  - **The order in the SQL:** each relaxed constraint is dropped only after its replacement exists, and the test checks it. The data steps run before the per-site index, which the old one-Linear index already kept free of collisions.
  - **Names:** every Linear row is named, revoked ones too (`Acme Linear`), and a row whose workspace name is blank or never read is `Linear`. GitHub rows keep `name` null. The domain's `isPendingAppId` reads `pending:<id>` and `pending`; `startLinearConnection` still writes `pending` (it reuses the organization's one row not revoked), and ticket 05 makes it write `pending:<id>`.
  - **`resumedIntoId`** has no foreign key, as `createdByMemberId`: a self-relation would need `ON DELETE SET NULL` on one column of a composite key, which Prisma can't declare, and connections are revoked, never deleted.
  - **`src/enums.ts`** had no `ConnectionKind` or `ConnectionCredential` mapping to grow: both are used as Prisma's own unions. The exhaustive `switch`es over them that changed: core's `tracker/connections.ts` (`jira` answers `null` until ticket 07), and the Linear router's `credentialKind`, narrowed to Linear's three (`linearCredentialOf`).
  - **The task page:** `apps/web/src/components/tasks/task-ticket.tsx`'s `trackerName` switches over the ticket's `ConnectionKind`, and `jira` would break it, but that folder belongs to milestone 10's thread build. So `packages/api`'s `taskPageTrackerOf` (`routers/task-extras.ts`) answers `linear` and `github` as they were and `null` for `jira`: `tasks.get` answers no ticket card for a Jira ticket, and the ticket context `tracker: null` ("from a ticket"), until ticket 16 adds Jira's case to `trackerName` (`taskPage.tracker.jira`) and removes `taskPageTrackerOf`. No Jira ticket can be cached before ticket 07.
  - **Milestone 2's test** "refuses a second Linear connection unless the first is revoked" (`schema-m2.test.ts`) went: its rule is gone, and `schema-m11.test.ts` holds the one that replaced it.
