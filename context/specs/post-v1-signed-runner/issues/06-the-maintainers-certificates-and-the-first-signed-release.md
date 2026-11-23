# 06: The maintainer's certificates and the first signed release

Status: ready-for-human
Builder: maintainer, with core
Blocked by: 02, 03, 04 (05 for the docs the release links)
Features: F-085
Packages: none (accounts, certificates and repository settings outside the repo; the run's evidence lands in this folder)
Spec: `../spec.md`, sections 5, 9 and 10; ADR 0075

## Why a person

Each step needs an identity, a payment or a legal entity that an agent doesn't have. Apple and Azure verify a person, and the certificates are issued to them; nothing in this repository can stand in for that, and no signing claim can be made until these exist.

**Nothing in tickets 01 to 05 needs these steps to land.** They change no behaviour a member sees until this ticket runs a release.

1. **Apple Developer Program membership.** Enroll (individual or organization) at `developer.apple.com/programs`; the yearly fee was accepted in ADR 0023. Record the date and the team's name.
2. **A Developer ID Application certificate and its private key.** Certificates, Identifiers & Profiles → Developer ID → Developer ID Application. Export the certificate with its key from Keychain Access as a `.p12` with a password. This signs the binary; a Developer ID *Installer* certificate isn't needed (ADR 0075: no `.pkg`).
3. **The Team ID** from `developer.apple.com/account/#/membership`.
4. **A notary credential.** Preferred: an App Store Connect API key (Users and Access → Keys), with its Key ID and Issuer ID, and the `.p8` downloaded once. Alternative: your Apple ID's app-specific password, which means the workflow's variables change (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`) — say which you chose.
5. **The Windows signature, which may not be available.** In the Azure portal, create a subscription's Artifact Signing account, complete **identity validation** (portal only, a person's documents), and create a certificate profile. Public Trust is limited to individuals in the USA and Canada and organizations in the USA, Canada, the EU and the UK (and the 2026 additions — the Azure quickstart lists them). **If you're not eligible, stop here and say so**: the plan's fallback is an OV certificate from a CA with its key in the CA's cloud HSM, which ticket 03 changes in one step.
6. **An Entra app for this repository**, with a federated credential for `JoeyKhd/ostra`'s release workflow and the Artifact Signing Certificate Profile Signer role. No client secret: GitHub's OIDC token is the credential.
7. **The repository's secrets and variables.** Secrets: `APPLE_CERTIFICATE_P12` (base64), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_P8` (base64). Variables: `APPLE_SIGNING_IDENTITY` (the certificate's common name), `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TS_ACCOUNT`, `AZURE_TS_PROFILE`, `AZURE_TS_ENDPOINT`. Nothing else, and nothing printed.
8. **A dry run before the real one**: `gh workflow run Release -f version=<next version> -f dry-run=true`. Its log goes to `demo/release-dry-run.log`. It proves the steps, not the signatures.
9. **The real release**: `gh workflow run Release -f version=<next version> -f dry-run=false`, after the v1 launch (ADR 0064's gates) and your go. Then download each zip on the machine it belongs to: on a Mac, unzip and run `./ostra runner --version` with no warning; on Windows, check Properties › Digital Signatures and run `ostra.exe`.
10. **The record**: the release's URL, the four assets' SHA-256s, the notarization submission ids, the Windows signature's subject and timestamp, a screenshot of each first run, and anything that surprised you — under this ticket's `## Comments`, dated. Then set F-085's status.

## Done when

- [ ] Each step above is done or answered, with the date, under `## Comments`, and step 5's answer names which Windows path the plan uses.
- [ ] A release is public with `ostra-darwin-arm64.zip`, `ostra-darwin-x64.zip`, `ostra-windows-x64.zip` and `SHA256SUMS`, and the checksums match the downloaded files.
- [ ] `F-085/c1` holds: the arm64 binary runs on a Mac after a download, with no unidentified-developer warning, and the notarization log has no error.
- [ ] `F-085/c2` holds: `ostra.exe` shows a valid Authenticode signature with a timestamp and a named publisher, and runs without an unknown-publisher warning. If SmartScreen still warns about reputation, it is recorded as Microsoft's verdict, with the file's signature shown valid, and the docs already say so (ticket 05).
- [ ] `context/features.md`'s F-085 row moves to `building` when the certificates exist and `done` only when every condition above holds; the ledger's row is the one this spec's section 10 proposes.
- [ ] `context/build-order.md`'s "What the maintainer provides" row for the signing certificates is updated from "Not needed for v1" to what this ticket settled.

## Comments
