# 25: API: pools, join tokens and approval

Status: done
Builder: api
Blocked by: 12
Features: F-091
Packages: `packages/api` (`src/routers/pools.ts` (new or grown), `src/routers/runners.ts`)
Spec: `../spec.md`, section 4 ("A pool and its tokens", "A join")

## What to build

- **`pools.create { name, requiresApproval, maxBoxes, joinTokenDays, projectIds }`** → `{ pool, joinToken }`, the token only in this answer. `pools.update`, `pools.list`, `pools.get` (its settings, runners, tokens without their values, projects).
- **`joinTokens.create { poolId, label, days | null }`** → the token once; `joinTokens.revoke { tokenId }`; `joinTokens.list { poolId }` (label, created by, expires, last used, uses, revoked).
- **`runners.approve { runnerId }`** and **`runners.reject { runnerId }`**, admins only; a runner already approved or revoked answers the same and changes nothing.
- Organization admins only for all of them; another organization's pool is `NOT_FOUND`. The token never appears in a log line, an error or any answer but the creating one.

## Done when

- [x] Tests named for `F-091`: each procedure as an admin, a member and another organization's admin; the token returned once and never by `list` or `get`; the rotation's two tokens both working until the revoke; approve and reject on a joining runner, and their repeats.
- [x] Break-it: returning the token's hash from `list` fails its test; recorded in `context/proof/F-091.md`.
- [x] Committed as `✨ add pools and join tokens to the API`.

## Comments

- 2026-11-20: built in `packages/api/src/routers/pools.ts` (new: `poolsRouter` moved out of `runners.ts`, and `joinTokensRouter`) and `runners.ts` (`approve`, `reject`), on ticket 12's use cases. Tests: `packages/api/src/routers/pools.test.ts`; proof rows in `context/proof/F-091.md`. Decisions:
  - `createPool` takes an optional `projectIds` (additive, in `m5-signatures.ts`): the pool goes at the end of each project's ordered list in the pool's own transaction, after the default pool for a project that had no list; another organization's project is `invalid-input` (`BAD_REQUEST`) and nothing of the pool stays.
  - `pools.create` answers `{ poolId, pool, joinToken }`; `poolId` stays for the panel's callers.
  - Milestone 2's `pools.joinTokens`, `pools.createJoinToken` and `pools.revokeJoinToken` stay, on the same code as `joinTokens.list`, `create` and `revoke`, until ticket 30 moves the panel. `createJoinToken` without `expiresInDays` now takes the pool's lifetime (else `OSTRA_JOIN_TOKEN_DAYS`, 30), not a fixed 30.
  - A repeated `joinTokens.revoke` answers the same with `changed: false`; a repeated `runners.approve` or `runners.reject`, or either on a runner already approved or revoked, answers its state with `changed: false` and changes nothing.
  - The API's settings gain `joinTokenDays` (and `devHostPoolSameUser` for ticket 26).
- 2026-11-20: commits 7f4c32f3 (`✨ let a new pool name its projects`) and 05d0cfbc (`✨ add pools and join tokens to the API`).
