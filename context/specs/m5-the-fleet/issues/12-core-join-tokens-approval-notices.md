# 12: Core: join tokens, approval and the join notices

Status: ready-for-agent
Builder: core
Blocked by: 03, 05
Features: F-091, F-036 (grown)
Packages: `apps/core` (`src/gateway/join-tokens.ts`, `src/gateway/endpoints.ts`), `packages/domain` (`createPool`, `updatePool`, `createJoinToken`, `revokeJoinToken`, `registerPoolRunner`, `approveRunner`, `rejectRunner`)
Spec: `../spec.md`, section 4 ("A pool and its tokens", "A join"); ADR 0029; section 11, item 18

## What to build

- **Tokens:** `createJoinToken` makes a random token with the log guard's prefix, stores its SHA-256, sets `expiresAt` from the pool's `joinTokenDays` (or `OSTRA_JOIN_TOKEN_DAYS`, or none), writes `join-token.created`, and returns the token once. `revokeJoinToken` sets `revokedAt` and `revokedByMemberId` and writes `join-token.revoked`; runners that joined with it stay.
- **The join:** milestone 1's register endpoint accepts any token of the pool that is neither expired (by the `Clock`) nor revoked, increments `useCount`, records `joinTokenId`, makes the runner `joining`, writes `runner.joined` naming the token, and enqueues `runner.join-notice`, in one transaction. A refused token answers one of `expired`, `revoked` or `unknown`, and nothing is written but a rate-limited log line with the token's ID when known.
- **Approval:** a runner in a pool that requires approval stays `joining`, connected or not, and is never offered a task (the admission's query, ticket 13, filters it; this ticket's test checks the offer path too). `approveRunner` moves it to `online` or `offline` and writes `runner.approved`; `rejectRunner` is milestone 2's revoke from `joining`, with `runner.rejected`. A pool with approval off moves a joined runner online at its first `hello`.
- **The notices:** `runner.join-notice` sends `runner_joined` to the organization's admins and, when the pool requires approval, opens a needs-you item `runner_awaiting_approval` for them, resolved by the approval or the reject.

## Done when

- [ ] Tests on the register endpoint, named for `F-091`: each token state accepted or refused; expiry by the clock; the token stored hashed and returned once; a rotation keeps a joined runner connected; an unapproved runner gets no offer; the audit entry and the job in the join's transaction (a rollback leaves neither); the notice and the needs-you item, and their resolution.
- [ ] Break-it: accepting an expired token fails its test; recorded in `context/proof/F-091.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add join tokens, approval and notices`.

## Comments
