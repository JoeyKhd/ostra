# 19: Runner: reports, labels, the pin and a pool runner's start

Status: done
Builder: runner
Blocked by: 01, 06, 10
Features: F-013, F-014, F-015, F-061, F-091, F-092
Packages: `apps/runner` (`src/run-runner.ts`, `src/server/info.ts`, `src/server/register.ts`, `src/pin.ts` (new), `src/connection/peer.ts`, `src/cli/`), `apps/runner/package.json` (`files`, `engines`, `bin`)
Spec: `../spec.md`, section 4 ("What a runner reports", "The pin"); ADR 0034 (amended), ADR 0046

## What to build

- **A pool runner's start:** `OSTRA_JOIN_TOKEN` (or `OSTRA_JOIN_TOKEN_FILE`), `--executor docker|kubernetes|host`, the key pair made on first start and kept owner-only, the register call, then `hello`. While `joining`, `ostra runner status` says "waiting for an admin to approve this runner in <pool>"; a refused token prints the reason (`expired`, `revoked`, `unknown`) and exits non-zero.
- **Reports:** `hello` and each `status` carry the executor's capabilities, `capacity()` as `resources`, slots, labels from `OSTRA_RUNNER_LABELS` (reserved prefixes refused at start with the reason), `install` and containment.
- **The pin** (ADR 0034, amended): at every start, read `/runner/v1/info`; when installed from npm and the versions differ, install the server's version with `npm install --prefix <dataDir>/versions/<version> --ignore-scripts` from `info.npm.registry` or `OSTRA_RUNNER_NPM_REGISTRY`, check the integrity npm recorded against the registry's, and re-exec that version with the same arguments and environment, once (a loop guard by environment marker). From the image or from source it installs nothing and logs the difference. `OSTRA_RUNNER_PIN=false` turns it off.
- **Drain and resume on the runner's side:** `drain` sets the flag that answers offers with no free slots; `resume` lifts it.
- **A personal runner's capacity** is 2 unless `OSTRA_RUNNER_SLOTS` says otherwise.
- **The npm CLI:** `pnpm --filter ostra pack` makes a tarball that installs and runs `ostra runner` on Node 24.5 or later, with `engines` set (ADR 0046).

## Done when

- [x] Tests named for their rows: a pool runner's start against the fake server through `joining`, approval and `online` (`F-091`); the reports' shapes (`F-092`); the pin against the fake npm registry, its integrity check refusing a tampered tarball, and its loop guard (`F-061`); `drain` and `resume` on offers (`F-092`); a personal runner's two (`F-014`); the packed CLI installs from its tarball and starts (`F-013`).
- [x] Break-it: skipping the integrity check lets the tampered tarball run and fails its test; recorded in `context/proof/F-061.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the pool runner's start and the pin`.

## Comments

- 2026-11-20: built.
  - **A pool runner's start:** `OSTRA_JOIN_TOKEN` (or the file) registers it, as before. Minor 4's `welcome` now carries a pool runner's `pool` (`poolId`, `name`, `awaitingApproval`; a minor-3 runner never sees it), and `approveRunner` sends a connected minor-4 runner `resume`, which lifts the wait as it lifts a drain. The runner keeps both in `status.json`; `ostra runner status` says "waiting for an admin to approve this runner in <pool>", then "Pool <name> (approved)". A refused token prints `expired`, `revoked` or `unknown` with the fix, and exits 1.
  - **Reports:** `hello` (its `executor` too) and each `status` carry `resources` (`null` on `host`, the Engine's offer on `docker`), `capabilities` (the executor's, `apps/runner/src/reports.ts`) and `install` (`npm` under a `node_modules` folder, `image` from `ENV OSTRA_INSTALL=image` in `deploy/Dockerfile.runner`, else `source`). A reserved label in `OSTRA_RUNNER_LABELS` stops the start with the reason. `--executor kubernetes` is ticket 20's.
  - **The pin:** `apps/runner/src/pin.ts`, run at start by an npm install only. One departure from the text: the runner downloads the tarball and checks its sha512 against the packument before npm installs that file, and then checks the lockfile's integrity again. npm doesn't check a local file, and checks a registry's tarball itself (`EINTEGRITY`), so this check is the one that sees a tampered tarball. A server whose info names no package is never pinned to (npm's `ostra` is someone else's, ADR 0046).
  - **Slots:** a `host` runner's are `OSTRA_RUNNER_SLOTS`, then the older `OSTRA_RUNNER_CAPACITY` (now optional), then 2. A `docker` runner's come from the Engine's offer.
  - **The npm CLI:** `pnpm --filter @ostra/runner pack:cli` (`apps/runner/src/pack/pack-cli.ts`), not `pnpm --filter ostra pack`: the repo root is named `ostra`, and the CLI's sources are TypeScript with workspace dependencies, which Node won't run from `node_modules`. It bundles `ostra` with esbuild 0.28.2 (a new exact dev dependency, already in the lockfile through vite) into one file with no dependencies, and packs it with npm.
  - **Tests:** `apps/runner/src/pin.test.ts` (F-061), `apps/runner/src/fleet-start.test.ts` (F-092, F-067), `apps/runner/src/pack/pack-cli.test.ts` (F-013), and `apps/core/src/gateway/runner-pool-start.test.ts`, which runs the real `ostra runner` against core's gateway through joining, approval and online (F-091, F-092, F-013). "A personal runner's two" is F-067's row (its `done when` names it), proved by core's admission tests and, on the runner's side, by `hostSlots`.
  - **Break-its,** each failing its test: `integrityMatches` passing anything; no `resume` from `approveRunner`; no `install` in the reports; the dispatcher taking an offer while draining; one slot by default; the tarball packed unbundled, then without the `require` shim.
  - Committed in 2d49827d.
  - **Fixed on the way:** `apps/runner/src/cli/package.test.ts` still expected the image's old `ENTRYPOINT ["node", …]`, which ticket 22 changed to the `ostra` shim.
- 2026-11-20 (review of apps/core): the pin is proved against the fake registry, but a production core answers `npm: null` on `/runner/v1/info`, so no runner of a real install pins. The CLI's npm name waits for the maintainer (ADR 0046), so F-061's pin row is `partial`, F-061 is `building`, and `docs/configuration.md` says the pin is inactive until milestone 7 publishes the CLI. Commit `🐛 fix review findings in apps/core`.
