# Signed runner downloads (F-085)

**Status:** spec, 2026-11-23. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** none. F-085 is on `build-order.md`'s "Right after" list, third in it after network allowlists (F-052) and Slack (F-057), and the trailing clause of ADR 0046 ("Signed binaries come after v1"). It lands after the v1 launch gate, on `main`, and it is not part of any milestone's demo. Its tickets can be built before the gate; only the first signed release waits for the maintainer's certificates.
**Features:** F-085 alone. No other ledger row changes state; the row gains this spec's conditions and its note (ticket 06).
**Decisions it builds on:** ADR 0046 (one `ostra` CLI and three images; signed binaries after v1; the CLI's version is the release's), ADR 0045 (what a release publishes), ADR 0064 (how v1 is released: one manual `release.yml`, a dry run that leaves nothing behind, files attached to the release), ADR 0023 (superseded; it named the Apple membership and the Windows certificate as the cost). **New for this spec:** ADR 0075, which fixes what is signed, by which credential, what each artifact is, and what the release proves before it attaches anything.
**Vendor facts** are cited at their source as they're used (Apple's notarization and Developer ID pages, Microsoft's code-signing options, Artifact Signing and SmartScreen pages, Bun's executable and codesign docs, SignPath's terms). They aren't in `context/research/`: this spec is the only place that needs them, and a finding file with one reader rots. The claims that a maintainer's credential or a signed artifact would have to prove are marked **[not yet proved]** and are ticket 06's.

---

## 1. What the feature ends with

A macOS or Windows member downloads one zip from the release, unzips it, and runs `ostra runner`. The operating system doesn't warn that the program's author is unknown, and doesn't refuse to open it.

In more words. The release at `github.com/JoeyKhd/ostra/releases/latest` carries, beside the compose file and the two charts, one zip per platform:

- `ostra-darwin-arm64.zip` and `ostra-darwin-x64.zip`, each holding `ostra` and `LICENSE`;
- `ostra-windows-x64.zip`, holding `ostra.exe` and `LICENSE`;
- `SHA256SUMS`, the SHA-256 of each zip in `sha256sum` format.

The macOS binaries are signed with the maintainer's Developer ID Application certificate under the hardened runtime and notarized by Apple; the Windows binary is Authenticode-signed through a certificate authority in Microsoft's Trusted Root Program, with a timestamp. The same `release.yml` that publishes the images and the npm packages builds them, signs them and attaches them; nothing is signed after the release exists and nothing is signed outside that workflow. The docs' runner page offers the download beside `npx ostra`, says which certificate signed which file and how to check it, and never types a version: the links are `releases/latest/download/<name>`.

The binary is the same program the npm CLI is, built from the same commit with Bun's single-file compile, with the release's version stamped in. `ostra --version` prints the release; a runner started from it is refused or accepted by the server exactly as one started from npm is, because the server sees the same protocol version and the same user agent.

### What v1 leaves that this starts from

Read from the code on `main` on 2026-11-23 (`9f1f76bb`):

- **One program, packed for npm.** `apps/runner/src/pack/pack-cli.ts` bundles `src/main.ts` with esbuild into `dist/npm/dist/ostra.js`, beside a `package.json` with no dependencies and `bin.ostra`, and packs it (`pnpm --filter @ostra/runner pack:cli`). The bundle inlines the root `package.json`'s `imageNamespace` and `cliPackage` through the `releaseNamesOnly` plugin, so the CLI's release identity is already a build-time substitution, not a file read at run time.
- **The version is the release's, read once.** `apps/runner/src/version.ts`'s `RUNNER_VERSION` comes from `apps/runner/package.json`'s `version`, which `scripts/version.ts` stamps before the release's checks (`scripts/release.ts`'s `stampRelease`). `userAgent()` writes `ostra-runner/<version> (<platform>; node <process.versions.node>)` **[to verify in the binary: what Bun reports there]**.
- **The release is one manual workflow.** `.github/workflows/release.yml` runs on `workflow_dispatch` only, refuses a real run without `OSTRA_CLI_PACKAGE` and `OSTRA_IMAGE_NAMESPACE`, stamps the tree, runs every check, makes the release's files, builds/starts/checks/pushes the three images, packs and publishes the npm packages (trusted publishing, no token), writes the notes, and creates the release with `gh release create … "$OUT"/assets/*`. `dry-run: true` is the default and leaves the job empty of published things.
- **The release's names are protocol's.** `packages/protocol/src/release.ts`'s `releaseFiles` (`compose.yaml`, `ostra-server.tgz`, `ostra-runner.tgz`), `ReleaseFile` and `releaseDownload(version, file)`; `scripts/release.ts`'s `releaseAssets` (the three files `release-assets.ts` makes), `linkedAssets` (what a page downloads), and `releaseWorkflowProblems` (the workflow's shape, as regexes over its text). `scripts/release.test.ts` holds "every file the docs download is one the release attaches" (`F-039/c2`) by comparing the pages' links to `releaseAssets`.
- **The checks a release runs**: `pnpm typecheck`, `lint`, `test`, `check:licenses`, `check:release`, `check:images`, `check:helm`. `check:release` is static and needs no network; `ci.yml` runs the same checks on every push.
- **There is no binary build anywhere.** No `bun` in any `package.json`, no `--compile`, no signing step, no certificate, and no docs page for a download. ADR 0046's "the runner is tested on Node… dropping Bun halves the runner's test matrix" is still true: nothing here runs the runner's tests under Bun.

### What is in, and what is not

**In:**
- a binary build of the CLI with Bun's `--compile`, cross-compiled in one Linux job for `darwin-arm64`, `darwin-x64` and `windows-x64`, from the stamped release tree, with Bun pinned by version and SHA-256 in the repo;
- macOS: `codesign` with a Developer ID Application certificate, the hardened runtime, a secure timestamp and the entitlements the JavaScript engine needs; `notarytool submit --wait`; a Gatekeeper assessment of the result;
- Windows: Authenticode signing through Artifact Signing (Azure) with the RFC 3161 timestamp Microsoft's service issues, and a signature verification that names the publisher;
- the release's files: four new names in `releaseFiles`, the signing jobs' artifacts attached by the same `gh release create`, and `SHA256SUMS` over the zips;
- `pnpm check:binaries`: a static check of the names, the workflow's job shape, the pinned Bun, the entitlements file and the docs' links, in `ci.yml` and in the release;
- docs: a downloads page (the page, the checksums, what's signed by whom, uninstall), the personal-runner page's install section, and the CLI reference's one line about the binary;
- the dry run: the whole shape with an ad-hoc macOS signature and a self-signed Windows one, nothing notarized, nothing attached.

**Not in** (and when it comes):
- **Windows arm64.** Bun builds it (`bun-windows-arm64`), but no machine in the matrix runs it, and a shipped binary nobody has run is a claim without proof. A later ticket, when a Windows-on-ARM machine is available.
- **Linux binaries.** The runner image is Linux's download (ADR 0046), and a tarball beside it would be a third path to document and test. Not planned.
- **A `.pkg` or an `.msi` installer, Homebrew, Scoop, winget.** ADR 0023 rejected the package channels for v1 and ADR 0075 keeps them out: a zip is enough to run a CLI. A pkg's Developer ID Installer certificate also stops old installers from running once it expires (Apple's Developer ID page), which a zip's signature doesn't.
- **Self-update.** The binary never replaces itself. A newer release is a new download, as an npm user is a new `npx`. The server's version window (F-061, ADR 0022) already refuses an out-of-window runner with the fix.
- **A signature on `SHA256SUMS`,** and any Sigstore/cosign attestation. The checksum proves a download arrived intact; the trust anchor is GitHub's own release page and HTTPS. A keyless signature is a dependency and a second thing to verify; it's an open question (Q-B), not a plan.
- **Notarization stapled to the macOS binary.** Apple: "Although tickets are created for standalone binaries, it's not currently possible to staple tickets to them." The ticket is served online, so the first launch needs the network. Recorded in ADR 0075 and in the docs.
- **A change to the server, the panel, the schema, the protocol or any adapter.** None.
- **Signing the images.** They're already published by digest and pulled by digest; image signing (cosign) is a separate feature with no ledger row.

---

## 2. No data model, no protocol, no settings

- **Schema:** untouched. No migration.
- **Settings:** none, required or optional. Nothing in the server, core, the panel or the runner reads a signing setting.
- **Wire protocol:** untouched. The binary speaks the same protocol minor as the npm CLI from the same commit.
- **Contracts that change, additively:**
  - `packages/protocol/src/release.ts`: `releaseFiles` gains `darwinArm64`, `darwinX64`, `windowsX64` and `checksums`; `ReleaseFile` widens with them. `releaseAssets` (the three files `release-assets.ts` makes) does not change.
  - A new `packages/deploy-checks/src/check-binaries.ts` and `src/binaries.ts` (the pinned Bun version and its SHA-256, the target list, the artifact names and the workflow rules), exported from the package's `index.ts`, with `binaries.test.ts`.
- **No adapter declares anything.** Nothing here is a tracker, agent or code host; the adapter parity rule doesn't apply, and `AGENTS.md`'s runner-parity rule is satisfied by the binary being the same program: the tasks it runs, the executors it offers and what it writes are the npm CLI's, unchanged.

---

## 3. The artifacts

| Name | Made by | Holds | Signed how |
|---|---|---|---|
| `ostra-darwin-arm64.zip` | `runner-binaries` (Linux), signed by `sign-macos` | `ostra`, `LICENSE` | Developer ID Application, hardened runtime, secure timestamp; notarized by Apple |
| `ostra-darwin-x64.zip` | the same | the same, for Intel Macs | the same |
| `ostra-windows-x64.zip` | the same, signed by `sign-windows` | `ostra.exe`, `LICENSE` | Authenticode, Artifact Signing certificate profile, RFC 3161 timestamp |
| `SHA256SUMS` | `runner-binaries`, completed after both signings | one line per zip: `<sha256>  <name>` | none (the release page is the anchor) |

- **`SHA256SUMS` is made last, from the files the jobs hand over.** The build job writes `unsigned-sha256.txt` (the bytes it hands to the signing jobs); each signing job re-computes its zip's SHA-256 after signing it and fails when it isn't the file it signed; the release job writes `SHA256SUMS` over the four zips it attaches, so a checksum is never transcribed.
- **A zip is the unit of signing only for the checksum; the signature is on the binary.** Zipping after signing, never before: `codesign` and `signtool` both operate on the executable's own bytes, and both are verified after unzipping in the job that runs it.
- **Names are versionless**, so `releases/latest/download/<name>` is always the newest release's (as the compose file and the charts already are). The version is inside: `ostra --version`, and the zip's own bytes.
- **Nothing enters `deploy/`**: no Dockerfile, no image, no chart. The binary is a release asset only.
- **The size** is Bun's runtime plus the bundle, about 60 to 100 MB uncompressed **[to measure in ticket 01]**. The spec sets no cap; the ticket records the measured size in the docs page so a download is a known cost, and `check:binaries` fails a zip over 150 MB, which catches an accidental `node_modules` or source map, not a Bun release.

---

## 4. The release: what the workflow does, in what order

`release.yml` gains three jobs, and its `release` job gains a `needs:` on the two signing jobs. All keep the workflow's one concurrency group, so a second dispatch still waits.

```
on: workflow_dispatch (version, dry-run)            unchanged
permissions: contents, packages, id-token write     unchanged (id-token already serves npm's provenance and now Azure's OIDC)

runner-binaries        runs-on ubuntu-24.04        needs: —          secrets: none
  checkout, pnpm install --frozen-lockfile
  node scripts/version.ts "$VERSION" …            (the same stamp: the version in RUNNER_VERSION)
  node packages/deploy-checks/src/install-bun.ts  (downloads the pinned Bun, checks its SHA-256 from binaries.ts)
  node scripts/build-runner-binaries.ts "$VERSION" "$OUT/binaries"
      -> out/darwin-arm64/ostra, out/darwin-x64/ostra, out/windows-x64/ostra.exe, out/unsigned-sha256.txt
  smoke: the three files exist, are not scripts, and `strings`-free checks pass (see §6)
  upload-artifact runner-binaries

sign-macos             runs-on: macos-15           needs: runner-binaries    secrets: APPLE_*
  download runner-binaries; verify each darwin file's SHA-256 against unsigned-sha256.txt
  security create-keychain / import the .p12 / set-key-partition-list
  codesign --force --options runtime --timestamp --entitlements … for both arch files
  codesign --verify --strict --verbose=2 ; codesign -dv (TeamIdentifier = $APPLE_TEAM_ID)
  ditto -c -k --keepParent (each arch) -> ostra-darwin-<arch>.zip
  xcrun notarytool submit <zip> --key <p8> --key-id … --issuer … --wait      (real run)
      dry run: skipped, printed as "notarization skipped: dry run"
  xcrun notarytool log <id> -> fail on any issue of severity error in the log
  quarantine the unzipped arm64 binary (xattr -w com.apple.quarantine) and run `./ostra --version`
      (real run); spctl --assess --type execute --verbose on both arch files
  upload-artifact signed-macos

sign-windows           runs-on: windows-2025       needs: runner-binaries    secrets: none (OIDC)
  download runner-binaries; verify ostra.exe's SHA-256 against unsigned-sha256.txt
  azure/login (client-id, tenant-id, subscription-id, federated credential)   (real run)
  signtool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256
       /dlib <Azure.CodeSigning.Dlib.dll> /dmdf metadata.json ostra.exe
      dry run: New-SelfSignedCertificate, signtool /f <pfx> /p … , "self-signed: not a release signature"
  signtool verify /pa /all ostra.exe ; Get-AuthenticodeSignature -> Status Valid,
       TimeStamperCertificate set (real run; the dry run asserts the same shape and says it's self-signed)
  .\ostra.exe --version equals $VERSION
  Compress-Archive -> ostra-windows-x64.zip
  upload-artifact signed-windows

release                runs-on: ubuntu-24.04       needs: [runner-binaries, sign-macos, sign-windows]
  … today's steps, unchanged …
  download signed-macos, signed-windows -> $OUT/binaries/
  node scripts/release-assets.ts "$OUT/assets"
  node scripts/release-binaries.ts "$OUT/binaries"   (verifies the four names, their SHA-256s, then writes SHA256SUMS)
  gh release create "v$VERSION" … "$OUT"/assets/* "$OUT"/binaries/*     (real run only)

docs                   needs: release               unchanged
```

- **Why the signing jobs come first.** `needs:` on `release` means nothing is pushed or published before both signatures exist. A failed notarization or an expired certificate stops the release before a single image is pushed, so there is no release with images and no binary. The cost is wall time: signing runs beside nothing, so the release starts a few minutes later. Apple's service usually answers in under an hour and 98% within 15 minutes (Apple, "Customizing the notarization workflow"); the job's timeout is 90 minutes.
- **Why the build and the signing are different jobs.** `codesign` and `signtool` only run on their own operating systems, and GitHub's macOS and Windows runners cost far more per minute than Linux. One Linux job builds all three binaries (Bun cross-compiles, its docs list `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`), and the two jobs that need a certificate do nothing but sign, run and zip what it handed them.
- **The handover is hashed.** The build job uploads `unsigned-sha256.txt` beside the files; each signing job recomputes and refuses a mismatch. So a certificate only ever signs bytes built by this workflow run from this checkout.
- **The real run refuses to start without the credentials**, in the same spirit as the existing names check: `sign-macos` fails its first step when `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` or `APPLE_API_ISSUER_ID` is empty; `sign-windows` fails when `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TS_ACCOUNT`, `AZURE_TS_PROFILE` or `AZURE_TS_ENDPOINT` is. Every value is a repository secret or variable, printed only as "set".
- **The dry run signs with a self-made identity.** macOS: `codesign --sign -` (ad-hoc), which produces a signature `codesign --verify` accepts and Gatekeeper rejects, so the step's checks are written to distinguish the two and the log says which ran. Windows: a `New-SelfSignedCertificate` certificate in the job's own store, which `signtool verify /pa` rejects as untrusted; the job asserts the status is *not* `Valid` and says why. Neither touches Apple's service nor Azure's. The dry run's log goes to `context/specs/post-v1-signed-runner/demo/release-dry-run.log` (the folder this spec adds), as ADR 0064 keeps milestone 7's.
- **The certificate lives for the job.** The `.p12` is base64 in a secret, decoded into a temporary keychain (`security create-keychain`, `import`, `set-key-partition-list`, `unlock-keychain`), used, and deleted in an `if: always()` step. No keychain item survives the runner; GitHub's macOS runners are ephemeral, but the step exists so a self-hosted runner later can't keep it.
- **Actions are pinned by SHA**, as `releaseWorkflowProblems` already enforces. The new ones are `actions/upload-artifact` and `actions/download-artifact` (already the repository's pattern elsewhere if present), `azure/login`, and `azure/artifact-signing-action`; if the last is renamed or unavailable, the `signtool … /dlib` call above is the step, unchanged, and only the login remains.

---

## 5. The credentials, and who can provide them

Everything in this table is outside the repository and only the maintainer can do it. None of it is an agent's step; ticket 06 is the maintainer's, and tickets 01 to 05 are blocked on nothing but the *shape* being decided.

| What | Who, and where it is created | Where it lives | What it unlocks | Blocked |
|---|---|---|---|---|
| **Apple Developer Program membership** (individual or organization; ADR 0023 accepted its yearly cost) | The maintainer, Account Holder, at `developer.apple.com/programs` | The maintainer's Apple account | Developer ID certificates and notarization (Apple: only program members get "Mac software notarization") | **Yes** |
| **Developer ID Application certificate + its private key** (`.p12` and its password) | The maintainer, Certificates, Identifiers & Profiles → Developer ID → Developer ID Application; requires the Account Holder role | `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, and the identity's common name as `APPLE_SIGNING_IDENTITY` | The macOS binaries' signature; notarization accepts only a Developer ID signature (Apple, "Resolving common notarization issues") | **Yes** |
| **Team ID** | The maintainer, `developer.apple.com/account/#/membership` | `APPLE_TEAM_ID` (variable, not a secret) | The signature's TeamIdentifier check and the notary's team | **Yes** |
| **App Store Connect API key** (Issuer ID, Key ID, `.p8`) | The maintainer, App Store Connect → Users and Access → Keys; a Team key needs a team admin, an Individual key doesn't and takes no `--issuer` | `APPLE_API_KEY_P8` (base64), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | `notarytool submit` (its man page's `-k/-d/-i`); the alternative is an Apple ID with an app-specific password and `--team-id`, which this plan doesn't use because an API key can be revoked alone | **Yes** |
| **An Azure subscription, tenant, Artifact Signing account, identity validation and certificate profile** | The maintainer, in the Azure portal, as Artifact Signing's quickstart walks it. **Identity validation is a person's, in the portal only** (no CLI). Public Trust eligibility: organizations in the USA, Canada, the EU, the UK (and, after the 2026 updates, Australia, New Zealand, Japan, South Korea, Singapore, Switzerland, Norway, Israel); **individuals only in the USA or Canada** | `AZURE_TS_ACCOUNT`, `AZURE_TS_PROFILE`, `AZURE_TS_ENDPOINT` (variables) | The Windows signature | **Yes — and it may not be available to the maintainer at all; see the open question** |
| **An Entra app registration with a federated credential for this repository**, holding Artifact Signing Certificate Profile Signer | The maintainer, in Entra and Artifact Signing's role assignment | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (variables), and no client secret: GitHub's OIDC token is the credential, as npm's trusted publishing is | `azure/login` in the Windows job | **Yes** |
| **A GitHub repository variable naming the release's entitlement** (optional) | — | — | Nothing planned; recorded here so a future change doesn't invent one | no |

**What the maintainer must decide before ticket 06:**
1. **Is a Windows signature available at all?** Artifact Signing limits individuals to the USA and Canada. If the maintainer is outside them and not signing as an organization in an eligible region, the fallback is an OV certificate from a CA such as DigiCert or Sectigo with its private key in the CA's cloud HSM (sold as a monthly subscription), which changes ticket 03's steps and its secrets and nothing else. ADR 0075 records both paths and why the workflow needs one of them.
2. **An Apple ID with an app-specific password** instead of the App Store Connect key, if creating a key is awkward. The workflow then holds `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_SPECIFIC_PASSWORD` and passes `--apple-id/--team-id/--password`.
3. **Where the two certificates are stored**: GitHub repository secrets are the plan (the release is already the maintainer's alone). A GitHub Environment named `release-signing` with a required reviewer would add an approval step to a workflow only the maintainer can start; the spec doesn't ask for it.

**[not yet proved]** Nothing in this spec has been signed by a real certificate. Until ticket 06 runs, every claim about notarization and Authenticode is a reading of the vendor's documentation, and the checks that prove it are described, not observed.

---

## 6. The binary

- **Built with Bun's `--compile`**, `bun build --compile --target=<target> apps/runner/src/main.ts --outfile <name>`. Bun bundles the entry's imports and its runtime into one file; its docs list every target this spec uses. A `define`-inlining or JSON-import plugin supplies the stamped version the way `pack-cli.ts`'s `releaseNamesOnly` does, so `RUNNER_VERSION` needs no change and `ostra --version` prints the release.
- **Bun is pinned and checked.** `packages/deploy-checks/src/binaries.ts` holds `BUN_VERSION` and the SHA-256 of the `bun-linux-x64` release zip; `install-bun.ts` downloads exactly that archive, verifies the hash from the repo's pin (never from the download, ADR 0046's rule for OpenCode's checksum), and unpacks the `bun` binary into the job's cache. `check:binaries` fails when the pin is missing, malformed, or unaccompanied by its version.
- **No source map, no minify-by-accident.** `--minify` is off in the plan: a stack trace from a member's binary is worth more than a few hundred kilobytes, and bytecode compilation (`--bytecode`) is measured in ticket 01 before it's used.
- **The external list is the npm bundle's**: `bufferutil` and `utf-8-validate` (ws's optional native speed-ups) stay external, so `ws` falls back to its JavaScript path exactly as the npm bundle does. If Bun refuses an import at compile time, the ticket says which and why; `node:zlib`, `node:fs` and the rest of the bundled graph are Bun's Node-compatible implementations.
- **macOS signing** is `codesign --force --options runtime --timestamp --entitlements apps/runner/pack/macos-entitlements.plist --sign "$APPLE_SIGNING_IDENTITY" <binary>`. The hardened runtime requires an entitlement for the JavaScript engine: Bun's codesign guide recommends `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables` and `disable-library-validation`; Apple says to use only the entitlements an app needs. **The plan starts from the smallest set that runs** (`allow-jit` and, if the engine needs it, `allow-unsigned-executable-memory`) and adds one only with the crash or the Apple error that demanded it, recorded in the ticket. The file is in the repo, so the entitlements are reviewed like any other input.
- **Windows signing** is Artifact Signing's SignTool invocation, exactly as its documentation shows: `/fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib <Azure.CodeSigning.Dlib.dll> /dmdf metadata.json`. The timestamp is not optional: Artifact Signing's certificates are valid for three days, so an untimestamped signature stops verifying almost immediately.
- **The user agent tells the truth about the runtime.** `userAgent()` writes `node ${process.versions.node}`; in a Bun binary that field may be Bun's Node-compatibility version or absent **[to verify]**. Ticket 01 makes it name the runtime it is running on (`bun <version>` or `node <version>`) with a test over both, so a support log can tell a download from an npm install. The server's parsing doesn't change; it's a log and a support field.
- **What is not signed, and the docs say so:** the zip itself and `SHA256SUMS`; the binary's contents after unzipping (the signature covers the file, and Gatekeeper/Authenticode verify it before the first run, not every run); the LICENSE.

---

## 7. Where the code changes

| File | Change | Ticket |
|---|---|---|
| `packages/protocol/src/release.ts` | `releaseFiles` + `darwinArm64`, `darwinX64`, `windowsX64`, `checksums` with their names; a doc line per file | 01 |
| `packages/deploy-checks/src/binaries.ts` (new) | `BUN_VERSION`, the Bun archive's SHA-256, the target list (`darwin-arm64`, `darwin-x64`, `windows-x64`), the artifact names, and `releaseProblems`-style rules over `release.yml`'s text | 01 |
| `packages/deploy-checks/src/install-bun.ts` (new) | Downloads and verifies the pinned Bun, prints its version | 01 |
| `scripts/build-runner-binaries.ts` (new) | Builds the three binaries from the stamped tree into `<out>/<target>/`, writes `unsigned-sha256.txt`, `--dry-run` prints its commands | 01 |
| `apps/runner/pack/macos-entitlements.plist` (new) | The entitlements, smallest first | 02 |
| `scripts/release-binaries.ts` (new) | Checks the four names and each zip's SHA-256, writes `SHA256SUMS`, lists them | 04 |
| `.github/workflows/release.yml` | The three jobs, `release`'s `needs:` and its download/attach steps | 02, 03, 04 |
| `package.json` | `check:binaries` → `node packages/deploy-checks/src/check-binaries.ts`, and the new scripts' entry points. No `bun` dependency is added to any workspace package | 01 |
| `.github/workflows/ci.yml` | one step: `pnpm check:binaries`, beside the other static checks | 04 |
| `apps/docs/content/runners/downloads.mdx` (new), `content/runners/meta.json`, `personal.mdx`, `reference/cli.mdx`, `install/upgrading.mdx` | §8 | 05 |
| `scripts/release.ts`, `scripts/release.test.ts` | `releaseWorkflowProblems`'s existing create-step rule accepts the binaries glob; the docs-link test compares to `releaseFiles`, not `releaseAssets`. F-085's own workflow rules live in `binaries.ts`, so `release.ts` doesn't grow a second home for them | 04 |

**A new dependency, named:** Bun, as the compiler (ADR 0023 and 0046 already chose it; it's a build tool, never a runtime dependency of any published package, and the runner's tests keep running on Node). **No npm package is added**: downloading Bun and verifying its hash is `fetch` and `crypto` in a script, as the OpenCode pin's build does.

---

## 8. Docs

- **`runners/downloads.mdx`** (new, after Personal runners): which zip for which machine; the links (`releases/latest/download/ostra-darwin-arm64.zip`, `…-x64.zip`, `…ostra-windows-x64.zip`, `…SHA256SUMS`); how to check the checksum (`shasum -a 256 -c SHA256SUMS` on macOS, `Get-FileHash -Algorithm SHA256` on Windows, with the line to compare); what signed it ("Developer ID Application, notarized by Apple" / "Authenticode, timestamped; the publisher is JoeyKhd"); **that the first macOS launch needs the network** because Apple's ticket is served online; that the binary is unsigned for no one and what to do if a warning still appears (report it, don't disable Gatekeeper); how to uninstall (delete the files and `~/.ostra/runner`); and the sentence that this is the same program as `npx ostra` and gets no updates of its own.
- **`runners/personal.mdx`**: "Install the CLI" gains the download beside npm, with macOS and Windows first, and says the binary needs no Node.
- **`reference/cli.mdx`**: one line under `ostra --version`: a download prints the release; nothing about where it came from.
- **`install/upgrading.mdx`**: a short "Upgrading a downloaded runner": download the new zip, replace the file, the data folder stays; the server's version window refuses one too old.
- **No page types a version.** Every link is `releases/latest/download/<name>`, and `release.test.ts`'s link test fails a page that links a name the release doesn't attach.
- **The blocks aren't `run`.** The download commands and the checksum lines are the reader's own values and files, so they're plain `sh` blocks: `check-docs-commands` only runs blocks marked `run`, and the proof job has no signed binaries to download. Ticket 05 says so in a line of the page's source comment, so the next person doesn't add `run`.

---

## 9. Tests and checks, with their keys

A feature's conditions come from its ledger row; this spec proposes the row's rewrite (ticket 06) and uses its keys here and in the tickets. Anything only a real, credentialed release shows is marked and left to ticket 06.

| Key | What it says | Where it's proved |
|---|---|---|
| `F-085/c1` | A macOS member downloads the arm64 zip, unzips it, and Gatekeeper accepts the notarized binary: it runs with a quarantine attribute and no unidentified-developer warning | `sign-macos` job: `codesign --verify --strict`, `spctl --assess --type execute`, `notarytool log` with no error, then `xattr`-quarantined `./ostra --version`. **Real run only** (ticket 06); the dry run proves the steps and prints that it signed ad hoc |
| `F-085/c2` | A Windows member downloads the x64 zip, Authenticode shows a publisher and a timestamp, and the binary runs without an unknown-publisher warning | `sign-windows` job: `signtool verify /pa /all`, `Get-AuthenticodeSignature` → `Valid` with `TimeStamperCertificate`, `ostra.exe --version`. **Real run only**; the SmartScreen *reputation* banner is Microsoft's verdict and is not proved (see §10) |
| `F-085/c3` | Every release attaches the three platform zips and `SHA256SUMS`, each zip holds exactly the binary and LICENSE, and `SHA256SUMS` matches the zips byte for byte | `release-binaries.test.ts` over fixture folders (names, contents, a wrong hash, a missing zip, an extra file) and `release-binaries.ts` in both release runs |
| `F-085/c4` | No page types a version, and every release file the docs link is one the release attaches | `release.test.ts` (`linkedAssets` against `releaseFiles`), extended in ticket 04 |
| `F-085/c5` | The release's shape is checked before it runs: the build job needs no secret, the two signing jobs are the only ones that read `secrets.`/Azure's identity, `release` needs both, and the attach step names both folders | `check:binaries`'s rules over `release.yml` (in `binaries.ts`), with a broken copy per rule (a secret in the build job, a missing `needs:`, an attach step that globs only `assets`) |
| `F-085/c6` | The binary is the release's: `ostra --version` equals the stamped version and `ostra --help` lists the npm bundle's commands | `build-runner-binaries.test.ts` (the plan, the names, a `0.0.0` tree refused), and each signing job, which runs the binary it signed (`--version`, `--help`) and compares against `node apps/runner/src/main.ts --help` from the same tree |
| `F-085/c7` | The pinned Bun is the one that builds: the version and SHA-256 in `binaries.ts` match the archive the build downloads, and a wrong pin fails the build | `binaries.test.ts` + `install-bun.ts`'s download in `runner-binaries` |
| `F-085/c8` | The macOS signature carries the hardened runtime and no entitlement beyond the ones the repo names | `codesign -d --entitlements - --verbose=4` in `sign-macos`, compared to `macos-entitlements.plist`; the dry run and real run alike |

**Static checks, no certificate, no network:**
- `pnpm check:binaries` in `ci.yml` and in `release.yml` before anything is built: the names, the pin, the entitlements file's presence, the workflow's rules, and the docs' links.
- `scripts/build-runner-binaries.test.ts`: the targets and output names as data, `--dry-run`'s printed commands, a release tree whose version is `0.0.0` refused ("stamp first"), an unknown target refused.
- `scripts/release-binaries.test.ts`: a fixture folder with the four files passes; a zip missing its LICENSE, a hash that doesn't match, a name not in `releaseFiles`, and a fifth zip each fail with that name.
- `packages/deploy-checks`'s `binaries.test.ts`: the pin's shape, the target list, and each workflow rule with its broken copy.

**Runs in a job, no certificate:** the `runner-binaries` job's own smoke checks: each file is a single executable of the right kind (`file` says Mach-O 64-bit arm64/x86_64 or PE32+), it isn't a shell script, and its size is within the cap.

**Runs in a job, with the maintainer's certificate (ticket 06):** everything in the table, once, on a real `1.1.0` release (or the first release after this lands).

---

## 10. Done when

The ledger row's conditions, rewritten (ticket 06 applies this to `context/features.md`):

> **F-085 | Signed runner downloads** | macOS and Windows members download the runner binary from a release, notarized or code-signed, and it opens without a security warning (ADR 0046, ADR 0075). Each release attaches `ostra-darwin-arm64.zip`, `ostra-darwin-x64.zip`, `ostra-windows-x64.zip` and `SHA256SUMS`, and the docs link them without typing a version. *Note 2026-11-23 (`specs/post-v1-signed-runner/`): ADR 0075 fixes what is signed and by which credential; the first signed release is blocked on the maintainer's Apple membership and Windows certificate.*

- `F-085/c1`: the macOS zips are signed with a Developer ID Application certificate under the hardened runtime, notarized, and run with a quarantine attribute without the unidentified-developer warning.
- `F-085/c2`: the Windows zip's `ostra.exe` verifies with Authenticode, names its publisher and carries a timestamp, and runs without an unknown-publisher warning.
- `F-085/c3`: each release attaches the three zips and `SHA256SUMS`, the zips hold what they should, and the checksums match.
- `F-085/c4`: no page types a version, and every file the docs link is one the release attaches.
- `F-085/c5`: a release can't publish without both signatures, and a static check holds the workflow to it.
- `F-085/c6`: the binary is the release's and the CLI's, same version and same commands.
- `F-085/c7`: the Bun that builds is pinned and verified.

**What only ticket 06 can settle, and how it is recorded:** the real release's run, its four assets' SHA-256s, the notarization submission id, the signature's subject and timestamp, and a screenshot of the macOS first run and of the Windows file's Properties › Digital Signatures. Under `## Comments`, dated, with the release's URL.

**Two honest limits, recorded rather than smoothed over:**
1. **Windows SmartScreen's reputation warning is Microsoft's to decide.** A correctly signed, timestamped file from a new publisher can still show "Windows protected your PC" until reputation accrues; since 2024 an EV certificate buys no instant bypass and OV and Artifact Signing certificates behave alike (Microsoft, "Code signing options"). The condition says *unknown publisher*, which a signature fixes, and not *no SmartScreen prompt ever*, which it doesn't. The docs page says the same.
2. **The first macOS launch needs the network**, because Apple can't staple a ticket to a bare binary. The docs say so; the alternative (a `.pkg`) trades that for an installer certificate whose expiry stops old installers (ADR 0075).

---

## 11. The tickets

| # | Ticket | Builder | Blocked by |
|---|---|---|---|
| 01 | The binary build: Bun pinned, three targets, the names in protocol, the build script | core | none |
| 02 | macOS: sign, notarize, and prove the binary opens | core | 01 |
| 03 | Windows: sign with Artifact Signing, and prove the publisher | core | 01 |
| 04 | The release's files: the attach, `SHA256SUMS`, `check:binaries`, the workflow's rules | core | 01, 02, 03 |
| 05 | Docs: the downloads page and the runner's install section | core | 01, 04 |
| 06 | The maintainer's certificates and the first signed release (blocked) | maintainer, with core | 02, 03, 04 |

**Who starts when.** 01 first: its names and its script are what 02 and 03 hand between jobs, and its Bun pin is what 04's rules read. 02 and 03 run in parallel once 01's artifact names and `unsigned-sha256.txt` exist; each is one job and its checks. 04 lands the attach and the static rules once both jobs' names are final. 05 writes the page from 04's names. 06 is the maintainer's, after all four, and the release it runs is the first with signed downloads; 01 to 05 change nothing a user sees until it runs.

---

## 12. Choices this spec makes, and what it considered

1. **A zip per platform, not an installer.** Chosen: no root, no uninstaller, one file to run, and the signature is on the executable. Considered: `.pkg` (staplable, offline first run, but an installer certificate whose expiry stops old installers from running — Apple's Developer ID page), `.msi` (same trade plus WiX), Homebrew/Scoop/winget (three channels to maintain).
2. **Bun's compile, not Node's SEA.** Chosen: ADR 0023 and 0046 already chose it, `--target` cross-compiles from one job (its docs list the targets), and it's what the agents ostra runs are built with (`research/agent-harnesses.md`). Considered: Node SEA (no new toolchain, but per-platform building and postject, and the bundle must be one CJS-ish file).
3. **Sign on the target operating system, build on Linux.** Chosen: one cheap build job, two short signing jobs. Considered: build on each OS (three runner images to keep, macOS minutes for compiling).
4. **Artifact Signing as the Windows plan, an OV+cloud HSM certificate as the fallback.** Chosen: Microsoft recommends it for non-Store distribution, its key never enters the repo or a laptop, and its SignTool/GitHub integration is documented. Considered: an OV certificate on a USB token (no unattended CI), SignPath Foundation (its terms require an OSI-approved license with no commercial dual-licensing, so ostra's Sustainable Use license doesn't qualify — SignPath's conditions page), a self-signed certificate (no).
5. **`SHA256SUMS` in `sha256sum` format, unsigned.** Chosen: every platform has a verifier built in, and it detects a damaged download. Considered: a signed checksum/manifest (a second signature to explain, and no new trust), Sigstore/cosign (a dependency and a second tool; Q-B).
6. **`needs:` on the release, so nothing publishes before the signatures exist.** Chosen over "attach later with `gh release upload`", which could leave a release with images and no binary.

**Dependencies:** Bun, as a build tool only (ADR 0023, 0046). No npm package, no new workspace dependency, no server setting. The Azure HTTPS calls are made by Microsoft's action and SignTool, not by ostra's code.

**Open questions** (for `context/open-questions.md`, which numbers them as it takes them; nothing in 01 to 05 waits on them, 06 does):
- **Q-A** Artifact Signing's Public Trust eligibility is limited by country for individuals (USA and Canada) and organizations (USA, Canada, EU, UK, and a longer list in the 2026 Azure docs). Is the maintainer eligible as an individual, as an organization, or not at all? If not, ticket 03's plan is the OV + cloud-HSM fallback.
- **Q-B** Should the release also carry a keyless signature over `SHA256SUMS` (Sigstore/cosign, GitHub OIDC)? It's a new dependency and a second verification step for a reader; the plan says no.
- **Q-C** Windows arm64: is a Windows-on-ARM machine (or a runner) available to prove it? The plan ships x64 only.
- **Q-D** Should the release also attach the bare unsigned binaries (no zip) for a reader who doesn't trust a zip? The plan says no: unsigned assets beside signed ones teach the wrong habit.
