# 05: Domain: capacity, the queue, choosing a runner, versions, the registry

Status: done
Builder: core (contracts, first)
Blocked by: 01, 04
Features: F-067, F-069, F-095, F-061, F-091, F-092, F-120
Packages: `packages/domain` (`src/lifecycles/`, `src/fleet/` (new), `src/use-cases/`, `src/jobs.ts`, `src/settings.ts`, `src/testing/`), `docs/configuration.md`
Spec: `../spec.md`, section 5.4; ADR 0059, ADR 0060

## What to build

- **Lifecycles:** the join token's; the runner's `approve` and `reject` from `joining`; a queued task's `cancel`. Exhaustive tests, every input from every state.
- **`src/fleet/`:** `runnerRoom`, `fits`, a pool's capacity and use, a project's use of a pool, `queueOrder`, `chooseRunner` and its reasons (new members of `dispatchWaitSchema`), `labelsMatch`, `runnerVersionState` and the registry's image name. Pure functions over rows, with no I/O.
- **The use-case signatures** of section 5.4, with the bodies that need nothing beyond the domain; the rest get their bodies in tickets 12 to 17.
- **Jobs:** `queue.admit`, `runner.join-notice` and `registry.check`, each with its key rule.
- **Settings:** every row of section 5.4's table, parsed with Zod with its default, and its line in `docs/configuration.md`. `OSTRA_DEV_HOST_POOL_SAME_USER` refuses to parse as true unless `NODE_ENV` is `development` or `test`.
- **Test helpers:** `seedPool`, `seedRunner` and `seedQueuedTask` in `@ostra/domain/testing`.

## Done when

- [x] Tests named for their rows: `chooseRunner`'s table covers every reason, each with a near miss (one label short, one slot short, a size one MiB too large, a share at its cap, a pool needing a registry, a task with services and only `host` online); `queueOrder` across priorities and ties; `runnerVersionState` at the window's edges; the room arithmetic with sizes, the sidecar and services counted.
- [x] Break-it: `labelsMatch` turned into an intersection fails `F-069`'s test; recorded in `context/proof/F-069.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the milestone 5 domain`.

## Comments

- 2026-11-19: built. `packages/domain/src/fleet/` (`capacity.ts`, `labels.ts`, `queue.ts`, `choose.ts`, `versions.ts`, `registry.ts`), pure over rows, with `fleet.test.ts`; the join token's lifecycle (`lifecycles/join-token.ts`, expiry from the clock), the runner's `approve { connected }` (online when connected, else still `joining`, approved, as `approveRunner` already behaves), a queued task's `cancel` to `stopped`/`cancelled`, and the box's `creating` with an optional `waiting` (inputs `waiting` and `scheduled`, no new state), each with its every-input-from-every-state table; the seven wait reasons in `dispatchWaitSchema` with milestone 1's sentence; the use-case signatures in `use-cases/m5-signatures.ts` (`approveRunner` and `rejectRunner` are milestone 1's, with bodies; `chooseRunner`'s body is the pure one; the rest get theirs in tickets 12 to 17); `queue.admit` (key per pool, `queueAdmitSingletonSeconds` 1), `runner.join-notice` (per runner) and `registry.check` (per organization and settings' version), with their queues in `packages/jobs`; `seedPool`, `seedRunner` and `seedQueuedTask` in `@ostra/domain/testing`. Choices: the reasons are checked in ADR 0059's order, then the room now; `pool-full` is the pool's own cap, and `queued { poolId, place }` is a fitting runner with no room now (the place comes from the admission); a pool's miss is the furthest check its runners reached, and the nearest miss is the pool that got furthest. A runner's `resources` is its whole offer, and the room subtracts the boxes ostra placed, from `Box` rows. The registry's image names are `registryImageRef` and `registryImageByDigest`, since milestone 3's `snapshotImageRef` names the local image. Settings: the server's four in `settings.ts`, with `OSTRA_DEV_HOST_POOL_SAME_USER` refused as true when `NODE_ENV` is `production`; the runner's rows in `packages/protocol/src/runner/config.ts`, which the runner parses, all with their defaults and their lines in `docs/configuration.md`. The docs list each setting under one process, so `OSTRA_DEV_HOST_POOL_SAME_USER` is the server's here, and the runner's reading of it is ticket 10's. `OSTRA_RUNNER_TRANSPORT` now takes `auto`, `websocket` and `http`, `auto` by default, and every value uses the WebSocket until ticket 18 builds the fallback (the docs say so). The sidecar's and a service's limits are runner settings; `defaultFootprintLimits` holds the same working values for the room arithmetic until ticket 13 passes the runner's. Proof: `context/proof/F-069.md` (four rows, `partial` until ticket 14 wires the admission), with break-its: `labelsMatch` as an intersection, the dropped `startedByMember` check and `startsServices` always true each failed their tests; the queue's order reversed failed `F-067`'s. Commit: `5ed7f6c8` (`✨ add the milestone 5 domain`).
