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

- [ ] Lifecycle tests: every input from every state, as the domain model's table says.
- [ ] Against the fake peer: revoking an online runner closes its socket with `4403` at once. In the same transaction its tasks are stopped as `runner_lost` and their epochs raised. A late event batch, a spec read and a credentials request with its still-valid access token are each refused, and its next token request fails. A reopened task dispatches to another runner.
- [ ] Revoking an offline, a joining and a draining runner does the same. Another organization's admin is refused, and so is a member who doesn't own the runner.
- [ ] Once ticket 38 has made `e2e/m2-failure-suite/`, it gains a case: a runner revoked mid-turn, and the task reopened on a second runner with its context.
- [ ] Proof (`AGENTS.md`, `context/proof/README.md`): each test that proves a condition of a row's "done when" names the row's ID in its title and has a break-it check, its rows are in `context/proof/`, and `pnpm check:proof` passes.
- [ ] The whole-repo checks pass (spec section 9: credentials, the runner protocol).
- [ ] Committed as `✨ add revoking a runner`.

## Comments
