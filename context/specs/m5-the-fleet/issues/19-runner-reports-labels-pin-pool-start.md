# 19: Runner: reports, labels, the pin and a pool runner's start

Status: ready-for-agent
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

- [ ] Tests named for their rows: a pool runner's start against the fake server through `joining`, approval and `online` (`F-091`); the reports' shapes (`F-092`); the pin against the fake npm registry, its integrity check refusing a tampered tarball, and its loop guard (`F-061`); `drain` and `resume` on offers (`F-092`); a personal runner's two (`F-014`); the packed CLI installs from its tarball and starts (`F-013`).
- [ ] Break-it: skipping the integrity check lets the tampered tarball run and fails its test; recorded in `context/proof/F-061.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the pool runner's start and the pin`.

## Comments
