# 42: Core accepts a pool's join tokens, and holds a runner for approval

Status: in-progress
Builder: core, api
Blocked by: none (24 and 33 are in)
Features: F-091, F-013
Packages: `apps/core` (`src/gateway/endpoints.ts`, `src/gateway/connections.ts`), `packages/domain`, `packages/api` (`src/routers/runners.ts`), `packages/db` (two additive columns on `Runner`)
Spec: `../spec.md`, section 2 (F-013); ADR 0029, "A join token is as sensitive as every secret of every project that may use its pool"

## Why

A follow-up from the demo, settled as Q130 on 2026-11-19 (`context/open-questions.md`, Settled). The panel's Runners page makes join tokens (`pools.createJoinToken`), and core's register accepts only the bootstrap one, so an admin gets a token that registers no runner. Core also moves every joining runner to `online` at its first connection, whatever its pool says, so accepting more tokens without the approval check would make a pool's "require approval" switch do nothing.

## What to build

- **Any token of the pool.** `registerPoolRunner` accepts a join token that isn't revoked and hasn't expired, the bootstrap one and the ones an admin makes alike. The rule of one runner name per pool stays. The join's audit entry names the join token's ID and says whether it was the bootstrap one.
- **Approval.** A runner that joins a pool with `requiresApproval` stays `joining`: `hello` applies the lifecycle's `accept` only when the pool doesn't require approval, or an admin approved this runner (`approvedAt` and `approvedByMemberId`, both nullable). It may stay connected, and it is offered no task, because the dispatcher offers to `online` runners only.
- **`runners.approve { runnerId }`,** for an organization admin: it records the approval and an audit entry, and moves a connected runner to `online` in the same transaction. A runner that isn't connected goes online at its next `hello`.
- **`runners.reject { runnerId }`,** for an organization admin: `joining` → `revoked`, with `evict` and a close with `4403` when it's connected, and an audit entry. Milestone 2's ticket 41 widens this to a revoke from any state.
- **`host` stays refused** for a pool runner, as today, until an admin's opt-in exists (F-015).
- **The panel:** the New token button now makes a token that works, with no other change. Approve and Reject on a `joining` runner's row have no place in the Runners target yet (`context/brand/app-targets/m1/runners.md`): the target is amended and approved first, and until then the two procedures ship with their tests.
- The notification to admins that F-091 asks for comes with notifications (F-036).

## Done when

- [x] Tests: a token made through `pools.createJoinToken` registers a runner; an expired one and a revoked one don't; a second runner of the same name in the pool is refused; the audit entry names the token; a token of another organization registers nothing here.
- [x] Tests: in a pool that requires approval, a joined runner stays `joining` across reconnects and is offered no task; after `runners.approve` it is online and takes one; after `runners.reject` it is revoked and its next token request fails. A pool without the switch behaves as today. A member who isn't an admin, and another organization's admin, can do neither.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] The whole-repo checks pass (spec section 9: credentials).
- [x] Committed as `🐛 accept a pool's join tokens`.

## Comments

**2026-11-19:** core's `registerPoolRunner` takes any join token of the pool that isn't revoked or expired, and the join's audit entry names the token and whether it was the bootstrap one. `hello` applies `accept` only when `awaitsApproval` (`packages/domain/src/use-cases/runner-approval.ts`) says no; `runners.approve` and `runners.reject` are admin procedures over `approveRunner` and `rejectRunner`, with the runner's row locked after its presence everywhere, so an approve can't miss a hello or a close. Two nullable columns on `runner` (`approvedAt`, `approvedByMemberId`). Eight tests in `apps/core/src/gateway/join-tokens.test.ts`, which make the tokens and decide through the panel's own procedures; each break in `context/proof/F-091.md` failed them. Whole-repo typecheck, lint, test, `check:licenses` and `check:proof` passed. The live run follows.
