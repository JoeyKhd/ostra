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
