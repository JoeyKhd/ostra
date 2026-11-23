# Signed runner downloads: what is signed, by whom, and what the release proves first

**Status:** accepted for the plan (2026-11-23, for `specs/post-v1-signed-runner/`). It fixes F-085. **Its two signing identities are the maintainer's and don't exist in the repository**: until they do, nothing here has been signed, and the first signed release is blocked on them. It fills in what ADR 0046 deferred to "when F-085 starts"; it doesn't change ADR 0046's distribution (one CLI, three images) or ADR 0064's release (one manual workflow, a dry run that leaves nothing behind).

A downloaded program that isn't signed is blocked by macOS's Gatekeeper and warned about by Windows SmartScreen (ADR 0023, ADR 0046). v1 needs neither: laptops use `npx ostra`, servers use the images. F-085 is the third path, for a member on macOS or Windows who wants one file and no Node. It ships three zips and a checksum file from the release, and the release refuses to publish without both signatures.

## The artifacts

| Asset | Holds | Signed |
|---|---|---|
| `ostra-darwin-arm64.zip`, `ostra-darwin-x64.zip` | `ostra`, `LICENSE` | Developer ID Application, hardened runtime, secure timestamp; notarized by Apple |
| `ostra-windows-x64.zip` | `ostra.exe`, `LICENSE` | Authenticode, a CA in Microsoft's Trusted Root Program, RFC 3161 timestamp |
| `SHA256SUMS` | the four zips' SHA-256, `sha256sum` format | none |

- **A zip, not an installer.** A CLI installs by unzipping; the signature is on the executable, and nothing needs root, a package database or an uninstaller.
- **A macOS ticket cannot be stapled to the binary.** Apple: "Although tickets are created for standalone binaries, it's not currently possible to staple tickets to them." Gatekeeper finds the ticket online, so the first launch needs the network; the docs say so.
- **Not a `.pkg`**, because a package is signed with a *Developer ID Installer* certificate, and Apple's own page says an installer "will only launch if your Developer ID Installer certificate is valid" — an expired certificate would stop old installers from running, which a zip's signature doesn't. Stapling and offline first launch aren't worth that.
- **Names are versionless**, so `releases/latest/download/<name>` is always newest, as the compose file and charts already are; the version is inside (`ostra --version`).
- **The platforms are three**: `darwin-arm64`, `darwin-x64`, `windows-x64`. Windows arm64 is a Bun target but no machine in the matrix runs it; shipping a binary nobody ran is a claim without evidence, so it waits.

## The identities

- **macOS: an Apple Developer Program membership, a Developer ID Application certificate and its private key, and notarization.** Apple's notary accepts only a Developer ID signature, requires the hardened runtime, a secure timestamp and no `get-task-allow` entitlement, and its service takes a zip for a standalone binary. The binary needs the JavaScript engine's hardened-runtime entitlement; the plan starts from the smallest set that runs and adds one only with the failure that demanded it, in a file in the repo.
- **Windows: Authenticode through a certificate authority in Microsoft's Trusted Root Program**, with a timestamp. The plan is Azure Artifact Signing (formerly Trusted Signing), which Microsoft recommends for non-Store distribution, keeps the private key in its service, and documents both a SignTool dlib and a GitHub Action. Its certificates last three days, so the timestamp is part of signing, not a nicety.
- **The fallback is an OV certificate with its key in the CA's cloud HSM** (DigiCert, Sectigo and others sell that), because Artifact Signing's Public Trust limits individuals to the USA and Canada. The fallback changes the signing step and its secrets, and nothing else.
- **SignPath Foundation is not available**: its free certificate requires an OSI-approved license "without commercial dual-licensing for all components", and ostra's license is source-available (ADR 0048).
- **The credentials are the maintainer's, not the repository's.** The Apple membership and account holder role, the certificate and its password, the Team ID, and the notary credential (an App Store Connect API key, or an Apple ID with an app-specific password) are created outside the repo. On Windows, the Azure subscription, Artifact Signing account, identity validation, certificate profile and an Entra app with a federated credential for this repository are the same. They live in GitHub repository secrets and variables, are refused when empty, and a key that leaves a job's temporary keychain is deleted in an `always()` step. **An agent can't create any of them, and an agent can't replace the evidence a real release leaves.**
- **No long-lived cloud secret**: the Windows job authenticates to Azure through GitHub's OIDC token, as npm's trusted publishing already does. The Apple credentials are the only long-lived secrets, and both can be revoked alone.

## How the release signs

- **One Linux job builds all three binaries** with Bun's `--compile` and its `--target` cross-compilation, from the stamped release tree, with Bun pinned by version and SHA-256 in the repo (never a checksum taken from the download, ADR 0046's rule for OpenCode). It hands the files and their SHA-256s to the signing jobs.
- **Two jobs sign, each on its own operating system**: `codesign` and `signtool` don't run elsewhere, and macOS and Windows minutes cost more than Linux's. Each verifies the hash it was handed, so a certificate signs only bytes this run built from this checkout.
- **The release job `needs:` both**, so no image is pushed and no package published before the signatures exist. A notarization failure or an expired certificate stops the release before anything is public.
- **The dry run signs too, with a self-made identity**: ad hoc on macOS, a self-signed certificate on Windows. It runs every step and every check that doesn't need the real credential, prints that it did not notarize or sign for release, and attaches nothing. Its log is evidence that the real run is one step.
- **`SHA256SUMS` is written last**, from the files the jobs hand over, never transcribed.

## Considered options

- **Unsigned binaries.** Rejected: the warning is the reason the feature exists.
- **Building on each operating system.** Rejected: three builds to keep in step, and macOS minutes for compiling what Linux compiles identically.
- **Signing after the release is published, with `gh release upload`.** Rejected: it allows a release with images and no binary, and a member who downloads in between gets the old asset set.
- **An installer (`.pkg`, `.msi`).** Rejected: root, an uninstaller and, for `.pkg`, an installer certificate whose expiry stops old installers.
- **Homebrew, Scoop and winget.** Rejected for now, as ADR 0023 and 0046: they can come beside the zips.
- **A signed checksum or a Sigstore attestation.** Not now: it adds a tool and a verification step without adding a trust anchor beyond GitHub's release page. An open question.
- **A self-signed certificate with instructions to trust it.** Rejected: it teaches a stranger to disable a security control.

## Consequences

- **Nothing publishes before signing**, so a release takes a few minutes longer and can fail on Apple's or Azure's side. That's the point.
- **The first macOS launch needs the network**, because Apple can't staple a standalone binary. The docs say so; a member without a network on first launch gets Gatekeeper's refusal and the page's explanation.
- **SmartScreen's reputation warning is Microsoft's verdict**, not ours: since 2024 an EV certificate buys no instant bypass, and OV and Artifact Signing certificates behave alike (Microsoft's "Code signing options"). A correctly signed file from a new publisher can still be warned about until reputation accrues. F-085's "unknown publisher" is fixed by the signature; "no SmartScreen prompt ever" is not promised, and the docs don't promise it.
- **Certificates must be renewed** (Apple's annually; Artifact Signing's profile is issued per signing and only the timestamp keeps a signature valid). An expired Apple certificate stops new signatures, not old releases: Apple's page says a Developer ID app runs as long as its certificate was valid when it was signed. A revoked certificate stops old releases from launching, which is the emergency lever Apple documents.
- **Windows arm64 and Linux downloads stay out** until a machine runs them.
- **The binary is the npm CLI's program**, so every runner-parity and adapter claim is unchanged: the same protocol version, the same executors, the same task behaviour, and the sidecar mode is the same code. Bun is a build tool, never a runtime dependency of a published package, and the runner's tests keep running on Node.
- **A static check holds the shape**: the names, the Bun pin, the entitlements file and the workflow's jobs (which job may read a secret, which must `needs:` both) are `pnpm check:binaries`, run by CI and by the release. A release that loses a signature step fails before it builds anything.
- **The maintainer's steps are explicit**: the membership, the certificate and its password, the Team ID, the notary credential, the Azure account with its identity validation, and the certificate profile. Until they exist, F-085 stays `planned`/`building` with this spec's plan, and no document claims a signed download works.
