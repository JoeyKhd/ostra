# 25: API: pools, join tokens and approval

Status: ready-for-agent
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

- [ ] Tests named for `F-091`: each procedure as an admin, a member and another organization's admin; the token returned once and never by `list` or `get`; the rotation's two tokens both working until the revoke; approve and reject on a joining runner, and their repeats.
- [ ] Break-it: returning the token's hash from `list` fails its test; recorded in `context/proof/F-091.md`.
- [ ] Committed as `✨ add pools and join tokens to the API`.

## Comments
