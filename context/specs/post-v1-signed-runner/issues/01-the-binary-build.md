# 01: The binary build: Bun pinned, three targets, the release's names

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-085
Packages: `packages/protocol` (`src/release.ts`), `packages/deploy-checks` (new `src/binaries.ts`, `src/install-bun.ts`, `src/check-binaries.ts`, `src/binaries.test.ts`, `src/index.ts`), `scripts/build-runner-binaries.ts` and its test, `apps/runner/src/version.ts` and its test, the root `package.json` (`check:binaries`)
Spec: `../spec.md`, sections 3, 6 and 12; ADR 0075 ("The artifacts", "How the release signs")

## What to build

**The release's names, in protocol** (section 3):

- `releaseFiles` gains `darwinArm64: "ostra-darwin-arm64.zip"`, `darwinX64: "ostra-darwin-x64.zip"`, `windowsX64: "ostra-windows-x64.zip"` and `checksums: "SHA256SUMS"`, each with a doc line saying what it holds and that the version is inside, not in the name. `ReleaseFile` widens with them; `releaseDownload` works unchanged. `releaseAssets` (the three files `release-assets.ts` makes) doesn't change. Grep every `switch`/`satisfies never` over `ReleaseFile`: there should be none, and there must not be a new one.

**The pin** (`packages/deploy-checks/src/binaries.ts`):

- `BUN_VERSION`, the `bun-linux-x64` archive's URL and its `sha256`, and `binaryTargets` (`darwin-arm64`, `darwin-x64`, `windows-x64`) with each target's Bun target name (`bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`), its folder name and its executable name (`ostra`, `ostra`, `ostra.exe`). Zod-validated, exported, so the check, the installer and the build read one source.
- `binaryProblems(files, workflowText)`: the names `releaseFiles` gains are exactly the three zips plus the checksums; the pin is 64 hex characters and its version is a Bun version; the entitlements file exists; and `release.yml` has a build job that runs the build script and reads no `secrets.`, and its real run's attach step names the signed folders. Each rule returns a named problem, as `releaseProblems`/`releaseWorkflowProblems` do.

**The installer** (`install-bun.ts`): downloads exactly the pinned archive, verifies its SHA-256 against the repo's pin (never against the download), unpacks the `bun` executable into `--out`, prints `bun --version`, and prints the planned command with `--dry-run`. A hash mismatch fails with both hashes; an unreachable archive fails with the URL.

**The build** (`scripts/build-runner-binaries.ts`): `node scripts/build-runner-binaries.ts <out-dir>` from the checkout root, for every target, `bun build --compile --target=<bun target> apps/runner/src/main.ts --outfile <out>/<target>/ostra[.exe]`, then copies `LICENSE` beside it, then writes `<out>/unsigned-sha256.txt` (`<sha256>  <target>/ostra[.exe]`). Refuses a checkout whose root `version` is `0.0.0` ("run node scripts/version.ts first"), an unknown `--target`, and an `out` folder that already holds files, as `release-assets.ts` does. `--dry-run` prints each command without running it. Every command is an argument array, never a shell string; a child process failure prints the command and its last lines and exits non-zero. `--minify` is off; measure `--bytecode` and record the result, using it only if it starts measurably faster and the size is acceptable.

**The runtime's name in the user agent** (`apps/runner/src/version.ts`): `userAgent()` says which runtime it is on (`bun <version>` when `process.versions.bun` is set, else `node <version>`), so a support log tells a download from an npm install. Verify first what Bun reports in `process.versions` for a compiled binary and write the field the truth requires; the server's parsing doesn't change. If a build-time constant is needed, inline it the way `pack-cli.ts`'s `releaseNamesOnly` inlines the release's names.

**`check:binaries`**: `node packages/deploy-checks/src/check-binaries.ts`, printed like `check:images`, in the root `package.json` beside the other checks. It runs with no network and no Bun installed.

**No dependency is added.** Bun is downloaded by `install-bun.ts` with `fetch` and `crypto`; nothing in any workspace package's `dependencies` names Bun.

## Done when

- [ ] Tests named for `F-085/c7`: the pin is a version and a 64-character hash; the installer refuses an archive whose hash differs (with both hashes named) and accepts the pinned one's shape; a missing or malformed pin fails `check:binaries` (break-it: change one hex character, and the installer fails).
- [ ] Tests named for `F-085/c3`: `releaseFiles`' new names are exactly the three zips and `SHA256SUMS`; `check:binaries` names each missing or extra one; `binaryProblems` returns nothing for the repository's own files.
- [ ] Tests named for `F-085/c6`: the build's plan is data (three targets, their Bun targets, folders and executable names); `--dry-run` prints one `bun build --compile` line per target and no command runs; a `0.0.0` root is refused; an out folder that isn't empty is refused; `ostra --version` is the root's version by construction (`RUNNER_VERSION` read from the stamped manifest), and the user agent reports the runtime it is on for both runtimes.
- [ ] `pnpm --filter @ostra/deploy-checks test`, `pnpm check:binaries`, and the root `typecheck`/`lint` pass for the touched packages.
- [ ] The measured sizes of the three binaries and the `--bytecode` measurement are under `## Comments`, and the sizes feed ticket 05's page.
- [ ] Committed as `✨ build the runner's native binaries`.

## Comments
