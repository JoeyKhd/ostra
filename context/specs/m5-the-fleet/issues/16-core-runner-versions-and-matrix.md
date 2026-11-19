# 16: Core: runner versions and the matrix

Status: done
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

- [x] Tests named for `F-061`: the matrix; the message's words; the outdated record; `info`'s shape.
- [x] Break-it: widening the window to two minors fails the matrix's refusal case; recorded in `context/proof/F-061.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add the runner version matrix`.

## Comments

- 2026-11-20: built. The window's words are `versionRefusalMessage` in `packages/protocol/src/runner/version.ts` ("This runner speaks protocol 1.2; this server accepts 1.3 to 1.5. Update it to v0.5.0. Fix: …"), used by `acceptHello`, which both carriers call. The matrix's recordings are `packages/protocol/src/testing/recorded/minor-{2..6}.json`, recorded once from the codecs at each minor and read with `readRecordedBuild`; minor 5 is minor 4 with one more optional field in `hello` (`spoolLimitBytes`). Tests: `packages/protocol/src/runner/version-matrix.test.ts` (the matrix over the recordings) and `apps/core/src/gateway/version-matrix.test.ts` (both carriers against the real gateway, the outdated record, `info`'s shape); `scripts/build-runner-at.test.ts`. Proof rows in `context/proof/F-061.md`; F-061 is `building` (the pin is ticket 19's, the panel tickets 26 and 31). Decisions made while building:
  - The refused runner is recorded on its own row, not a new one: its `version`, its `minor` and `lastSeenAt` (when), written once per build (`recordRefusedRunner` in `packages/domain/src/use-cases/runner-report.ts`), with a change notice. `runnerRowVersionState` reads a row's state for the panel, `outside` for a refused build. No migration was needed.
  - `info`'s `npm` is the gateway's `runnerNpm`: `null` in production until milestone 7 names the published package, and in development (`NODE_ENV=development`) `{ package: "ostra", registry: "http://127.0.0.1:14873" }`, `pnpm dev:npm-registry`'s default address. Core reads no new setting for it.
  - `scripts/build-runner-at.ts` builds the tags `milestone-4` and `milestone-3`, which don't exist yet: until the maintainer tags them, the demo names the commits with `--ref milestone-4=<commit> --ref milestone-3=<commit>`. Each build is a detached worktree in `.ostra-dev/runner-builds/` with its own `pnpm install --frozen-lockfile`, and says the minor its source speaks. It wasn't run here (two full installs); its plan is tested, and ticket 37's step 10 runs it.
