# 05: Domain: capacity, the queue, choosing a runner, versions, the registry

Status: ready-for-agent
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

- [ ] Tests named for their rows: `chooseRunner`'s table covers every reason, each with a near miss (one label short, one slot short, a size one MiB too large, a share at its cap, a pool needing a registry, a task with services and only `host` online); `queueOrder` across priorities and ties; `runnerVersionState` at the window's edges; the room arithmetic with sizes, the sidecar and services counted.
- [ ] Break-it: `labelsMatch` turned into an intersection fails `F-069`'s test; recorded in `context/proof/F-069.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the milestone 5 domain`.

## Comments
