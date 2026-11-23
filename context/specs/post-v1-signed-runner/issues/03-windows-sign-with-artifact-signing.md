# 03: Windows: sign with Artifact Signing, and prove the publisher

Status: ready-for-agent
Builder: core
Blocked by: 01
Features: F-085
Packages: `.github/workflows/release.yml` (a new `sign-windows` job, and the build job's Windows file), `packages/deploy-checks/src/binaries.ts` (the workflow's Windows rules)
Spec: `../spec.md`, sections 4, 5 and 6; ADR 0075

## What to build

**The job** (`sign-windows`, `runs-on: windows-2025`, `needs: runner-binaries`):

1. `actions/download-artifact` the build's folder; verify `windows-x64/ostra.exe`'s SHA-256 against `unsigned-sha256.txt`, failing on a mismatch.
2. A first step that refuses a real run with an empty `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_TS_ACCOUNT`, `AZURE_TS_PROFILE` or `AZURE_TS_ENDPOINT`, printing "a real run needs the maintainer's Artifact Signing account (ticket 06)" and nothing about their values.
3. **Real run:** `azure/login` with `client-id`/`tenant-id`/`subscription-id` and no client secret (the workflow's `id-token: write` is the federated credential), then install the Artifact Signing client tools (`winget install -e --id Microsoft.Azure.ArtifactSigningClientTools`, the package Microsoft's page names) and write `metadata.json` in the job from the three variables, with the region `Endpoint` the account's (`ERR: a mismatched endpoint is a 403`, so the step reads it from `AZURE_TS_ENDPOINT` rather than a literal).
4. **Real run:** `signtool sign /v /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib "<Artifact Signing dlib>\x64\Azure.CodeSigning.Dlib.dll" /dmdf metadata.json ostra.exe`. If `azure/artifact-signing-action` (pinned by SHA) is the current supported action, it may replace steps 3's login and this call; the SignTool call is the fallback and must stay in the ticket's comments as the thing that ran.
   **Dry run:** `New-SelfSignedCertificate -Type CodeSigningCert` into the job's store, `signtool sign /f <pfx> /p <password> /fd SHA256 /t http://timestamp.digicert.com ostra.exe`, and the checks below expect a *self-signed* result and say so.
5. `signtool verify /pa /all /v ostra.exe`; then `Get-AuthenticodeSignature ostra.exe`: **real run** expects `Status -eq 'Valid'`, a `SignerCertificate` whose `Subject` names the maintainer's identity, and a non-null `TimeStamperCertificate` (Artifact Signing's certificates last three days, so a missing timestamp is a failed release); **dry run** expects the status *not* to be `Valid` and asserts the timestamp is present.
6. `.\ostra.exe --version` equals `$VERSION`; `.\ostra.exe --help` prints the same command names as `node apps/runner/src/main.ts --help` from the same tree (normalise line endings).
7. `Compress-Archive` `ostra.exe` and `LICENSE` into `ostra-windows-x64.zip`; upload it as the job's artifact.
8. `if: always()`: remove `metadata.json`, the temp `.pfx` and the store's certificate; `azure/logout`.

**Rules for the workflow** (in `binaries.ts`): `sign-windows` needs the build job, runs on a Windows runner, signs with `/fd SHA256` and a `/tr` timestamp, verifies with `signtool verify /pa`, runs the binary, and reads no `secrets.` (OIDC). A copy that drops the timestamp, a copy that drops `signtool verify`, and a copy that adds a client secret (`AZURE_CLIENT_SECRET`) each fail, the last with the reason: no long-lived cloud secret, as npm's trusted publishing already has none.

**What this ticket does not do**: it can't prove `F-085/c2` — a real signature, a real publisher and a timestamp need the maintainer's certificate profile (ticket 06). And SmartScreen's *reputation* is out of reach in any job: the ticket records in `## Comments` that the check proves a valid, timestamped signature, not Microsoft's cloud verdict, and that a first release may still be warned about.

**If the maintainer turns out not to be eligible for Artifact Signing** (see the spec's Q-A): this ticket's job becomes the OV-certificate fallback — the CA's own signing tool and its secrets in place of the dlib and the login — and the workflow rules change only in name. Don't start the swap before the maintainer's answer.

## Done when

- [ ] Tests named for `F-085/c5`: the four broken copies above fail with their rules named, and the repository's workflow passes.
- [ ] Tests named for `F-085/c6`: the dry run's `.exe` prints the release's version and the npm CLI's commands; the version check fails when the tree isn't stamped.
- [ ] `pnpm check:binaries` passes, the dry run's log is in `demo/`, it says the signature is self-signed, and no secret appears in it.
- [ ] `## Comments` states what the dry run proved, that a real signature, publisher and timestamp wait on ticket 06, and what SmartScreen's reputation means for F-085's wording.
- [ ] Committed as `✨ code-sign the Windows runner`.

## Comments
