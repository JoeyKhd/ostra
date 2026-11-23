# 01: DB: the Trello migration

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-153
Packages: `packages/db` (a new migration, `prisma/schema.prisma`), `packages/db/src/testing/` if the migration fixture needs it
Spec: `../spec.md`, section 5.1; ADR 0072; ADR 0071

## What to build

- **`ConnectionKind` gains `trello`** and **`ConnectionCredential` gains `trello_token`**, both in `prisma/schema.prisma`, with the doc comments naming what they are (Trello; a bot member's never-expiring token).
- **`Connection.apiKey` (String, null)**, Trello's app key, with a comment that it is *not* a secret (it travels in the consent URL and every call), that the app's secret is `webhookSecretSecretRef` (its only job is signing deliveries) and the token `accessTokenSecretRef`.
- **One migration**, `<timestamp>_trello`, after the latest one on `main`. It only adds the two enum values and the nullable column: no data is copied, no row rewritten, no constraint dropped, no column renamed.
- **The migration test** in `packages/db`: run the migration set over a milestone 11 database with a Linear connection, a Jira connection, two boards, their tickets and a Trello-shaped insert; assert every existing row reads back unchanged, a `trello` row inserts with `trello_token` and `apiKey`, `apiKey` is null on the others, and `pnpm db:migrate` on a copy of the previous set is clean.
- **The isolation test stays green** (milestone 4's generated one); no new organization-scoped table is added.

## Done when

- [ ] Tests named for `F-153/c1`: a `trello` connection row inserts with its key, secret refs, member ID and `trello_token`, and the view's read of it (ticket 04) gets every field; another organization's row is invisible.
- [ ] The migration test proves the add-only claim: the milestone 11 fixture reads back byte for byte, no constraint is dropped, and re-running the previous release's migrations on the migrated database still starts.
- [ ] `pnpm typecheck` and `pnpm test` for `packages/db` pass, and the whole-repo checks (spec section 9) before the push.
- [ ] Committed as `✨ add the Trello migration` (one logical change; a failing check is fixed forward).
