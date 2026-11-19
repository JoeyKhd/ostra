# 16: Core: runner versions and the matrix

Status: ready-for-agent
Builder: core
Blocked by: 01, 05
Features: F-061
Packages: `apps/core` (`src/gateway/`, `src/http.ts` for `/runner/v1/info`), `packages/protocol` (`src/testing/recorded/` (new)), `scripts/build-runner-at.ts` (new). `ci.yml` doesn't change: the matrix is plain unit tests over fixtures
Spec: `../spec.md`, section 4 ("The pin"); ADR 0034 (amended), ADR 0022

## What to build

- **`/runner/v1/info`** answers `version`, `minorWindow` and `npm { package, registry }` (the CLI's package name and `OSTRA_RUNNER_NPM_REGISTRY` when set; `null` before milestone 7 names the package, with the demo's fake registry in development).
- **The window on both carriers:** a `hello` outside it is refused with the runner's minor, the window and the version to install, as `version.ts` words it; the refused runner is recorded once (its version, minor and when) so the fleet view lists it as outdated without a runner row of its own.
- **The version state** (`runnerVersionState`) on every runner, for the panel.
- **The compatibility matrix:** recorded frame fixtures of minors 3, 4 and 5 (5 is a synthetic next minor with one extra optional field, as spike 6 did), checked against a server at 4 on both carriers: 3 and 5 work and are encoded down, 2 and 6 are refused with the fix. It runs in `pnpm test`, so in `ci.yml`, as plain unit tests.
- **The real build one minor apart,** for ticket 37: a script that builds the runner from milestone 4's tag and from milestone 3's, so the demo's step 10 runs real builds, not a flag.

## Done when

- [ ] Tests named for `F-061`: the matrix; the message's words; the outdated record; `info`'s shape.
- [ ] Break-it: widening the window to two minors fails the matrix's refusal case; recorded in `context/proof/F-061.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the runner version matrix`.

## Comments
