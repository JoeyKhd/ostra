# 15: Core: drain and resume

Status: done
Builder: core
Blocked by: 01, 05
Features: F-092
Packages: `apps/core` (`src/gateway/`), `packages/domain` (`drainRunner`, `resumeRunner`)
Spec: `../spec.md`, section 4 ("Drain and resume"); ADR 0029 ("Drain, resume and revoke"); milestone 2's ticket 41, which left this here

## What to build

- **`drainRunner`:** from `online` or `offline`, one transaction: `draining`, `drainedAt`, `drainedByMemberId`, a `drain` command through the outbox, the audit entry `runner.drained`, the server-only event. Its running tasks finish; the admission offers it nothing.
- **`resumeRunner`:** from `draining`, to `online` when its presence row is live and to `offline` otherwise, a `resume` command for a minor-4 runner (a minor-3 runner gets none, and the result says it takes tasks after it restarts), `runner.resumed`, and a `queue.admit` for its pool.
- **The hold survives** a disconnect, a reconnect, the runner's restart and every core replica's restart: the state is the row's, and `hello` never changes `draining`.
- Admins only, for any runner of the organization; a member can't drain their own personal runner (they stop it instead).

## Done when

- [x] Tests against the fake peer, named for `F-092`: a drained runner gets no offer while a task it holds finishes; it stays draining through a disconnect, a restart and a server restart; resume to online and to offline; the `resume` command applied once; a minor-3 runner gets no `resume`; a member is refused.
- [x] Break-it: letting `hello` move a draining runner online fails the restart test; recorded in `context/proof/F-092.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add drain and resume`.

## Comments

- 2026-11-19: built. `drainRunner` and `resumeRunner` (`packages/domain/src/use-cases/drain-runner.ts`) keep the m5 signatures: each opens its own transaction, takes the runner's row `FOR UPDATE` (presence is read after it without a lock, as approve does), and writes the state, the outbox command, the audit entry (`runner.drained`, `runner.resumed`, new in the closed list) and the change notice together. A resume reads the minor from the runner's presence row (its newest connection), then from `Runner.minor`; below 4 it sends no `resume` and says so in `commandSent`. A pool runner's resume enqueues `queue.admit` for its pool (ticket 13 works it). `hello` was already right: the lifecycle's `reconnected` and `disconnected` keep `draining`. Choices: the server-only `runner.drained` and `runner.resumed` events are task events, so they go on the timeline of each task the runner holds a lease of (a runner has no timeline of its own); a resume clears `drainedAt` and `drainedByMemberId`; another organization's admin gets `not-found`. Tests: `apps/core/src/gateway/drain.test.ts`, against a fake peer on the real gateway and the real dispatch. Break-its: `hello` lifting a drain failed the restart test; `resume` sent at every minor failed the minor-3 test. Proof: `context/proof/F-092.md`, the drain row, still `partial` until the Runners page has Drain and Resume (tickets 26 and 31). Checks: typecheck and lint of `@ostra/domain` and its dependents, the tests of `@ostra/domain` and `@ostra/core`, `check:licenses`, `check:proof`.
