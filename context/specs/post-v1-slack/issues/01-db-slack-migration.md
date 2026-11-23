# 01: DB: the Slack migration

Status: ready-for-agent
Builder: core
Features: F-057
Packages: `packages/db` (`prisma/schema.prisma`, a new migration, `src/enums.ts`, the migration test), and the exhaustive switches the new channel value breaks
Blocked by: none
Spec: `../spec.md`, section 4.1; ADR 0074

## What to build

One migration after the last one on `main`, additive only:

- **`NotificationChannel` + `slack`.** The old release keeps reading every value; the new one alone writes `slack`. `src/enums.ts`'s mappings gain it, and every exhaustive `switch` over the channel compiles in this commit: domain's `adapterNameOf` and `channelsFor`, core's `notify.deliver`, the panel's column label, and any `satisfies never` over the enum. Where the switch's `slack` arm would need this feature's logic (domain and core), widen the domain list in ticket 04 and the worker in ticket 05, and leave the code compiling with the domain's list as its source (no hand-written three).
- **`SlackInstallation`** (`@@map("slack_installation")`): `id`, `organizationId` **unique**, `state` (`SlackInstallState`: `pending`, `active`, `failed`, `revoked`), `clientId`, `clientSecretSecretRef`, `botTokenSecretRef`, `refreshTokenSecretRef` (null when rotation is off), `teamId`, `teamName`, `botUserId`, `appId`, `scopes` (`String[]`, default `[]`), `tokenExpiresAt`, `lastCheckedAt`, `lastError`, `oauthStateHash`, `oauthStateExpiresAt`, `installedByMemberId`, `revokedAt`, `createdAt`, `updatedAt`. Every secret column is a string holding a `SecretRef`, with a `///` line saying so and that no value is in it. The organization relation cascades.
- **`SlackIdentity`** (`@@map("slack_identity")`): `id`, `organizationId`, `memberId`, `slackUserId`, `slackTeamId`, `matchedEmail`, `checkedAt`, `createdAt`, `updatedAt`; **`@@unique([organizationId, memberId])`**, the member relation cascades, and `@@index([organizationId, slackUserId])`. A row means matched; no row means not matched.
- **No change to `NotificationPreference`**, `Notification`, `NotificationDelivery` or `EmailSettings`.

## Done when

- [ ] Tests named for `F-057/c2`: the two tables store only `SecretRef`-shaped strings in their secret columns (a test writes and reads them through the schema), no column can hold a token and no page-facing query selects one. A migration over a milestone 11 database leaves every row readable, adds the two tables and the enum value, and changes no existing row.
- [ ] Tests named for `F-057/c8`: `SlackInstallation.organizationId` is unique — a second row for one organization is refused by Postgres; a `SlackIdentity` of another organization's member can't be written (the composite relation refuses it); the generated `every-record.test.ts` covers both tables and passes.
- [ ] The migration test runs both ways over a fixture at `main`'s last migration, and the schema-matches-migrations check passes.
- [ ] Typecheck, lint and tests for `packages/db` and its direct consumers (domain, core, api, web) pass, with the whole-repo checks (the schema changed).
- [ ] Committed as `✨ add Slack's tables and channel`.

## Comments

- 2026-11-23, core: built as `✨ add Slack's tables and channel`. Migration
  `20261205100000_slack_installation` (after F-052's `20261205000000_environment_network_rule`);
  tests in `packages/db/src/schema-slack.test.ts` (`F-057/c2` three times, `F-057/c8` three times)
  and the generated `packages/api/src/isolation/every-record.test.ts`'s guard. Readings and
  differences:
  - **`src/enums.ts` had no `NotificationChannel` mapping to grow:** like `ConnectionKind` in
    milestone 11, the enum is used as Prisma's own union. What the schema change did break was the
    domain's fan-out, where a stored preference row's channel was spread into `NotificationChoice`
    because Postgres's three values were the domain's three. `choices.ts` gains
    `isNotificationChannel`, derived from `notificationChannels`, and the fan-out keeps only the
    channels the domain offers: a `slack` preference row is no choice until ticket 04 widens the
    list, and no hand-written three was added.
  - **The delivery worker's `slack` arm is explicitly deferred:** `notify.deliver` switches over
    Postgres's channel and now has `case "slack"` as a final failure in words ("not built yet"),
    which ticket 05 replaces with `deps.slack.deliver`. No Slack delivery can be written before
    ticket 04's fan-out offers the channel.
  - **The panel's column label needed nothing:** it switches over `"panel" | ChoosableChannel`,
    still `["tracker", "email"]`; ticket 07 adds the fourth column.
  - **`installedByMemberId` has no foreign key**, as `Connection.createdByMemberId`: the audit entry
    keeps the actor, and the row outlives a membership. `SlackIdentity`'s member relation is the
    composite `[memberId, organizationId]`, so another organization's member is refused by Postgres.
  - **No row changes:** the migration's only statement about an existing object is `ALTER TYPE
    "NotificationChannel" ADD VALUE 'slack'`; the test applies it over a milestone 11 fixture and
    compares every `notification`, `notification_delivery` and `notification_preference` row before
    and after.
