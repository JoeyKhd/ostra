# 04: The release's files: the attach, SHA256SUMS, and the static checks

Status: ready-for-agent
Builder: core
Blocked by: 01, 02, 03
Features: F-085
Packages: `scripts/release-binaries.ts` and its test, `scripts/release.ts` (`releaseWorkflowProblems`), `scripts/release.test.ts`, `.github/workflows/release.yml` (the `release` job), `.github/workflows/ci.yml`, `packages/deploy-checks/src/binaries.ts`
Spec: `../spec.md`, sections 3, 4 and 9; ADR 0075

## What to build

**`scripts/release-binaries.ts`** (`node scripts/release-binaries.ts <folder>`): the folder the two signing jobs' artifacts were downloaded into. It checks it holds exactly `ostra-darwin-arm64.zip`, `ostra-darwin-x64.zip`, `ostra-windows-x64.zip` (names from `releaseFiles`, never typed twice) and nothing else; opens each zip and asserts it holds exactly the executable and `LICENSE` (`yauzl`-free: Node's `zlib` with the zip's central directory is fine, or the script shells to `unzip -l` only if a parser is genuinely too much — say which and why in the comments); computes each zip's SHA-256; writes `SHA256SUMS` as `<hex>  <name>` lines sorted by name; prints each file's size and hash. Fails on a missing file, an extra file, a zip whose contents differ, and a file of zero bytes.

**The release job** (`release.yml`):

- `needs: [runner-binaries, sign-macos, sign-windows]`, so nothing is pushed or published before both signatures exist.
- Two `actions/download-artifact` steps (or one with `pattern: signed-*` and `merge-multiple: true`) into `$OUT/binaries/`.
- `node scripts/release-binaries.ts "$OUT/binaries"` after the artifact download and before the notes.
- `gh release create "v$VERSION" … "$OUT"/assets/* "$OUT"/binaries/*` in the real run; the dry run runs the same script and lists the files, attaching nothing.
- `releaseWorkflowProblems`'s existing rule for the create step (line ~451) must accept the second glob; update its regex and its test's expectation in the same commit, and keep its meaning: the assets folder and the binaries folder, both globbed, nothing else.

**The static checks:**

- `packages/deploy-checks/src/binaries.ts`'s rules over `release.yml`: the `release` job `needs:` the build and both signing jobs; the download step names the signed folders; `scripts/release-binaries.ts` runs before the release is created; `ci.yml` has a `check:binaries` step; the four names in `releaseFiles` are the four files `release-binaries.ts` expects. Each with a broken copy in `binaries.test.ts`.
- `.github/workflows/ci.yml`: one step, `pnpm check:binaries`, beside the other static checks. It needs no network, no Bun and no certificate.

**`scripts/release.test.ts`:**

- The docs-link test (`F-039/c2`) compares the pages' links to `releaseFiles`, not `releaseAssets`, and its `expect(names).toEqual([...])` lists the seven names (three files made by `release-assets.ts`, three zips, the checksums) once ticket 05 adds the page's links. Until then it lists four; the ticket's last step is the page, so land 05's links and this assertion in whichever order leaves `main` green, or in one commit with 05 if the test can't pass in between — say which in `## Comments`.
- `makeReleaseAssets`'s assertion that it makes exactly `releaseAssets` stays, proving the three stamped files and the signed zips stay separate producers.

## Done when

- [ ] Tests named for `F-085/c3`: a fixture folder with the four files passes and `SHA256SUMS` matches each zip byte for byte; a missing zip, a fifth zip, a zip holding an extra file, a zip missing `LICENSE`, and a truncated file each fail with that name; `SHA256SUMS` is sorted and in `sha256sum` format.
- [ ] Tests named for `F-085/c5`: `check:binaries` fails a workflow whose `release` job lacks `needs: sign-macos` or `needs: sign-windows`, one whose create step globs only `assets`, one whose binaries script runs after the create, and a `ci.yml` without the step.
- [ ] Tests named for `F-085/c4`: the link test fails a page linking `ostra-linux-x64.zip`, and passes the repository once ticket 05's page is in.
- [ ] `pnpm check:binaries`, `pnpm check:release` and the whole-repo `typecheck`/`lint`/`test` pass; the workflow's dry run passes and its log shows the four files listed and `SHA256SUMS` written.
- [ ] Committed as `✨ attach the signed runners to a release`.

## Comments
