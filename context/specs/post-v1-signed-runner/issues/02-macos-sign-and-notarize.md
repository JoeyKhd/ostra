# 02: macOS: sign, notarize, and prove the binary opens

Status: ready-for-agent
Builder: core
Blocked by: 01
Features: F-085
Packages: `.github/workflows/release.yml` (the `runner-binaries` job and a new `sign-macos` job), new `apps/runner/pack/macos-entitlements.plist`, `packages/deploy-checks/src/binaries.ts` (the workflow's macOS rules)
Spec: `../spec.md`, sections 4, 5 and 6; ADR 0075 ("The identities", "How the release signs", "Consequences")

## What to build

**The build job** (`runner-binaries`, `ubuntu-24.04`, no secret): checkout with `fetch-depth: 0`, `pnpm install --frozen-lockfile`, `node scripts/version.ts "$VERSION" "$IMAGE_NAMESPACE" "$CLI_PACKAGE"`, `node packages/deploy-checks/src/install-bun.ts`, `node scripts/build-runner-binaries.ts "$OUT/binaries"`, the smoke checks (each file is a single executable of the right kind — `file` says Mach-O 64-bit arm64, Mach-O 64-bit x86_64 or PE32+ — and within the size cap), then `actions/upload-artifact` of the folder. It reads no secret: a step fails if the job's text mentions `secrets.`.

**The signing job** (`sign-macos`, `runs-on: macos-15`, `needs: runner-binaries`; no `environment:`, the workflow is the maintainer's alone, as ADR 0064 has it):

1. `actions/download-artifact` the build's folder; verify each darwin file's SHA-256 against `unsigned-sha256.txt`, failing on a mismatch.
2. A first step that refuses a real run with an empty `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` or `APPLE_API_ISSUER_ID`, printing "a real run needs the maintainer's Apple credentials (ticket 06)" and nothing about their values.
3. Add a temporary keychain, import the `.p12`, `set-key-partition-list`, unlock it, and (real run only) write the `.p8` to a temp file.
4. `codesign --force --options runtime --timestamp --entitlements apps/runner/pack/macos-entitlements.plist --sign "$APPLE_SIGNING_IDENTITY" <binary>` for both architectures; `codesign --verify --strict --verbose=2` each; `codesign -dv` each, asserting the TeamIdentifier is `$APPLE_TEAM_ID` and the flags include the hardened runtime; `codesign -d --entitlements - --verbose=4` each, compared to the repository's plist (`F-085/c8`).
5. `ditto -c -k --keepParent` each signed binary with its LICENSE into `ostra-darwin-<arch>.zip`.
6. Real run: `xcrun notarytool submit <zip> --key <p8> --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID" --wait`, twice (one submission per zip, as Apple's service takes one file), then `xcrun notarytool log <id>` for each and fail on any `issues[]` entry whose `severity` is `error`. Dry run: print "notarization skipped: dry run" and sign ad hoc (`codesign --sign -`), which `codesign --verify` accepts and Gatekeeper refuses; the checks say which mode ran.
7. Real run: unzip the arm64 zip into a temp folder, set the quarantine attribute a browser would (`xattr -w com.apple.quarantine "<flags>;<date>;Safari;"`, the value Launch Services writes), and run `./ostra --version`; `spctl --assess --type execute --verbose` on both architecture files. **Verify the attribute actually makes Gatekeeper evaluate the file** — a malformed value is the classic way this check passes without testing anything: the step first proves the check bites by running an unsigned copy the same way and expecting a refusal, then the signed one and expecting a clean run. Dry run: run the unquarantined arm64 binary and expect `--version` to work; `spctl` is expected to refuse and the step says so. The uploaded artifact is the zip only: the `.p12`, the `.p8` and anything under the temp keychain stay out of every artifact path.
8. Upload `ostra-darwin-arm64.zip`, `ostra-darwin-x64.zip` as the job's artifact.
9. `if: always()`: delete the keychain, the `.p12`, the `.p8` and the temp folders.

**The entitlements file**: the smallest set that runs a Bun binary, in `apps/runner/pack/macos-entitlements.plist`. Start with `com.apple.security.cs.allow-jit` alone; add `allow-unsigned-executable-memory` only if the engine refuses to start without it, and neither of the other three Bun's guide lists unless a crash and its entitlement name demand one. The file's header comment says which entitlement was demanded by what, with the command that showed it.

**Rules for the workflow** (in `binaries.ts`, called by `check:binaries`): the `sign-macos` job `needs:` the build job, runs on a macOS runner, names the entitlements file, runs `codesign` with `--options runtime` and `--timestamp`, runs `notarytool submit` with `--wait` and a `log` step, and is the only job besides `sign-windows` that reads `secrets.APPLE_*`/`secrets.AZURE_*`. Each rule has a broken copy in its test.

**What this ticket does not do**: it can't prove `F-085/c1` — that needs the maintainer's certificate and a real submission (ticket 06). It leaves the dry run's log under `context/specs/post-v1-signed-runner/demo/release-dry-run.log` and, in `## Comments`, the exact gap: x64's *launch* is unproved until an Intel Mac runs it (`macos-13` if GitHub still offers it, else the maintainer's machine); `spctl`'s assessment of the x64 file is not a launch.

## Done when

- [ ] Tests named for `F-085/c8`: a signed binary's entitlements equal the repository's plist, and `check:binaries` fails a plist that gains an entitlement without a line in the rules and a comment naming why.
- [ ] Tests named for `F-085/c5`: the workflow rules pass on the repository's new `release.yml` and fail a copy that drops `--options runtime`, a copy that drops `notarytool log`, a copy whose `sign-macos` reads a secret in the build job, and a copy that removes `needs:` (break-it: each one).
- [ ] `pnpm check:binaries` and the workflow's dry run pass; the dry run's log is in `demo/`, `notarization skipped: dry run` is in it, and no secret appears.
- [ ] `## Comments` states what the dry run proved, what only ticket 06 can prove, and the x64 launch gap.
- [ ] Committed as `✨ sign and notarize the macOS runner`.

## Comments
