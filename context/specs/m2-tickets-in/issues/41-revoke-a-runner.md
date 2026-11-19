# 41: Revoke a runner at once, and the runner lifecycle's drain and resume

Status: ready-for-agent
Builder: core (the domain and the gateway), api; web for the row action
Blocked by: none
Features: F-013, F-091, F-092, F-045
Packages: `packages/domain` (`lifecycles/runner.ts`, a new `revokeRunner` use case), `apps/core` (`src/gateway/`, `src/dispatch/endpoints.ts`), `packages/api` (`routers/runners.ts`), `apps/web` (`src/components/runners/`), `apps/web/messages/en.json`
Spec: `../spec.md`, section 7 (follow-ups); `context/domain-model.md`, "A runner's lifecycle"; ADR 0029, "Drain, resume and revoke"; ADR 0034, "Auth"

## Why

Settled as Q131 and Q108 on 2026-11-19 (`context/open-questions.md`, Settled). A runner key is on a member's laptop from milestone 1, and nothing can revoke it: the lifecycle allows a revoke only from `draining`, and no procedure sets either state. A leaked key can't wait for milestone 5's fleet view.

## What to build

- **The lifecycle,** as the domain model now draws it, with exhaustive tests:
  - `revoke` from `joining`, `online`, `offline` and `draining`
  - `drain` from `online` and from `offline`
  - a new `resume { connected }` from `draining`, to `online` or to `offline`
  - `disconnected` and `reconnected` leave a draining runner draining
- **`revokeRunner`,** one transaction:
  - the runner becomes `revoked`, with `revokedAt`
  - every active lease of it ends, with the end reason `runner-revoked`, and each task's epoch goes up, so a late write is refused (F-045)
  - each of those tasks stops as `runner_lost` and its session stops, and its box moves as the grace's end moves it (`apps/core/src/ingest/grace.ts`). There is no grace: a revoked runner can't come back
  - the gateway is told (`notifyRunnerInTx`, `revoked`), so the replica that holds the runner sends `evict` and closes with `4403`
  - an audit entry: who, which runner, how many tasks it stopped
- **A revoked runner's access token is refused everywhere,** though its ten minutes may not be over: the spec, the credentials and the blob endpoints read the runner's row with the lease. The token endpoint refuses it already.
- **`runners.revoke { runnerId }`:** an organization admin, for any runner of the organization; a member, for a personal runner they own. A runner already revoked answers the same and changes nothing.
- **The panel:** a Revoke action on a runner's row, under Runners for admins and under Your machine for one's own, with a confirm that says how many tasks it stops. The Runners target (`context/brand/app-targets/m1/runners.md`) has no row actions yet: the target is amended and approved first, and until then the procedure ships with its tests.
- **Not here:** the Drain and Resume actions and the `resume` command the runner needs for them. They are the fleet view's (F-092, milestone 5). This ticket only makes the lifecycle function match the domain model.

## Done when

- [x] Lifecycle tests: every input from every state, as the domain model's table says.
- [x] Against the fake peer: revoking an online runner closes its socket with `4403` at once. In the same transaction its tasks are stopped as `runner_lost` and their epochs raised. A late event batch, a spec read and a credentials request with its still-valid access token are each refused, and its next token request fails. A reopened task dispatches to another runner.
- [x] Revoking an offline, a joining and a draining runner does the same. Another organization's admin is refused, and so is a member who doesn't own the runner.
- [ ] Once ticket 38 has made `e2e/m2-failure-suite/`, it gains a case: a runner revoked mid-turn, and the task reopened on a second runner with its context.
- [x] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [x] The whole-repo checks pass (spec section 9: credentials, the runner protocol).
- [x] Committed as `✨ add revoking a runner`.

## Comments
- 2026-11-19, core: done in `✨ add revoking a runner` (549e15c), except the failure-suite case (`e2e/m2-failure-suite/` doesn't exist yet: ticket 38 adds the case when it makes the suite) and the panel's Revoke action, which waits for the Runners target to be amended and approved.
  - **Lifecycle** (`packages/domain/src/lifecycles/runner.ts`): `revoke` from any state but `revoked`; `drain` from `online` and `offline`; `resume { connected }` from `draining`; `disconnected` and `reconnected` leave a draining runner draining. `lifecycles.test.ts` checks every input from every state against the domain model's table.
  - **`revokeRunner`** (`packages/domain/src/use-cases/revoke-runner.ts`), one transaction: the task rows are locked first, by ID, then the runner's row, in the order the dispatch, a stop and the outbox take them. Leases end with `endReason` `runner-revoked` (`RUNNER_REVOKED_END_REASON`), epochs go up, tasks stop as `runner_lost`, sessions stop, boxes move as the grace's end moves them, `notifyRunnerInTx(revoked)`, a `task.stopped` audit entry per task and one `runner.revoked` with `from` and `stoppedTasks`. No `stop` command is queued: the runner can't connect again.
  - **The token:** `runnerIsLive` (`apps/core/src/gateway/access-token.ts`) reads the runner's row on every endpoint that takes an access token: the WebSocket upgrade and the task's spec and credentials now; ticket 12's bulk path calls it too.
  - **The dispatch** locks the chosen runner's row and reads it again before the grant, so a revoke that commits while a dispatch reads its candidates never gets a lease.
  - **`runners.revoke { runnerId }`** (memberProcedure): an admin any runner of the organization, a member their own personal runner (`FORBIDDEN` otherwise, `NOT_FOUND` for another organization's). It answers `{ runnerId, alreadyRevoked, stoppedTasks }`; the confirm's count is the row's `busy` from `runners.list` and `runners.mine`.
  - Tests: `apps/core/src/gateway/revoke.test.ts` (fake peer: 4403 within 5 s with the sweep at 60 s, the late batch, spec, credentials, upgrade and token refused, a failed transaction changing nothing, the reopen dispatched to the other pool runner, offline/joining/draining, the refusals) and `packages/api/src/routers/runners-revoke.test.ts`. Proof rows: F-091 (each runner revoked on its own, `partial`: rotation is ticket m1-42's) and F-092 (revoke, `partial`: no row action yet, drain is milestone 5).
