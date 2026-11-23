# 05: Docs: the downloads page and the runner's install section

Status: ready-for-agent
Builder: core
Blocked by: 01, 04
Features: F-085
Packages: `apps/docs` (new `content/runners/downloads.mdx`, `content/runners/meta.json`, `content/runners/personal.mdx`, `content/reference/cli.mdx`, `content/install/upgrading.mdx`)
Spec: `../spec.md`, section 8; ADR 0075 ("Consequences")

## What to build

**`runners/downloads.mdx`** — after Personal runners in `runners/meta.json`, titled as the section's pages are:

- **Which file**: a three-row table — Apple silicon → `ostra-darwin-arm64.zip`; Intel Mac → `ostra-darwin-x64.zip`; Windows x64 → `ostra-windows-x64.zip` — each a `releases/latest/download/<name>` link, plus `SHA256SUMS`. No version typed anywhere.
- **What to do**: `unzip`, `chmod +x ostra` (macOS), then `./ostra runner --server http://localhost:8787`; on Windows, `Expand-Archive` and `.\ostra.exe runner …`. Say the data folder is `~/.ostra/runner` as for the npm CLI, and that a binary needs no Node and no git beyond what the runner already needs.
- **Check the download**: `curl -fsSLO …SHA256SUMS` then `shasum -a 256 -c SHA256SUMS` on macOS; `Get-FileHash -Algorithm SHA256 ostra-windows-x64.zip` and the matching line on Windows. The lines to compare are on the release's page.
- **What signed it, and by whom**: "signed with a Developer ID Application certificate under Apple's hardened runtime and notarized by Apple" and "Authenticode-signed and timestamped; the publisher is JoeyKhd". Say plainly that the zip and the checksum file aren't signed themselves.
- **Two honest limits**, as the spec's section 10 has them: the first macOS launch needs the network, because Apple can't staple a ticket to a standalone binary; and Windows may still show SmartScreen's "Windows protected your PC" for a new publisher until reputation accrues, which is Microsoft's verdict, not the signature's — the fix is *Run anyway* only after checking the publisher is JoeyKhd, never disabling a control.
- **If a warning still appears**: report it (`SECURITY.md`), don't disable Gatekeeper or SmartScreen, and use `npx ostra` meanwhile.
- **Uninstall**: delete the folder and `~/.ostra/runner`; nothing else is installed.
- **No self-update**: a newer release is a new download; the server's version window refuses one too old and says so.
- **The commands are plain `sh` blocks, not `run`.** One line of the page's own source comment (or the ticket's `## Comments`, if the page has no room for a comment) says why: `check-docs-commands` only runs ` ```sh run ` blocks, the reader's platform is theirs to pick, and the proof job has no signed binaries to fetch. A future maintainer mustn't mark them `run`.

**`runners/personal.mdx`**: "Install the CLI" gains the download beside npm, macOS and Windows first, one sentence each, with the link to the new page. Keep the existing paragraph about `npx` and the clone.

**`reference/cli.mdx`**: one line under `ostra --version`: a download prints the release it came from; nothing else changes.

**`install/upgrading.mdx`**: a short section, "Upgrading a downloaded runner": download the new zip, replace the file, the data folder stays; the server's window decides whether it must.

**Nothing else**: no page promises stapling, no page says a download is verified offline, and no page types a version.

## Done when

- [ ] The link test (`scripts/release.test.ts`, `F-085/c4`) passes with the new page's links; it fails if a link's name isn't one the release attaches.
- [ ] Every download link is `releases/latest/download/<name>`; grep the page for a version and find none.
- [ ] The four pages' claims match the workflow's reality: the names, the certificates, the timestamp, the data folder, the lack of self-update.
- [ ] No block on the page is marked `run`, and the page's source comment says why.
- [ ] `pnpm --filter @ostra/docs` typechecks and lints; the docs site builds.
- [ ] Committed as `📝 document the signed runner downloads`.

## Comments
