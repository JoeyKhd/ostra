# 30: Release: versions, `release.yml` and its dry run, `SECURITY.md`, `CONTRIBUTING.md`

Status: ready-for-agent
Builder: core
Blocked by: 29, and ticket 34's yes for Changesets (or the fallback)
Features: F-039 (its publishing)
Packages: `.github/workflows/release.yml` (new), `.changeset/` or `scripts/version.ts` (new), every published package's `package.json` (`publishConfig`, `files`, `repository`), `CONTRIBUTING.md` (new), `NOTICE`
Spec: `../spec.md`, section 4; ADR 0045 (amended), ADR 0064 ("The release")

## What to build

- **Versions:** Changesets once the maintainer says yes, configured to bump every published package together; until then `scripts/version.ts`, which sets one version on every published `package.json` and the images' tags. This ticket says which under `## Comments`.
- **What's published,** each with `publishConfig.access: public`, `files` limited to its build and `LICENSE`, `repository` and `provenance: true`: the CLI under the name the maintainer registers (a placeholder until then, never published), `@<scope>/protocol`, `@<scope>/adapter-sdk` and the adapters. The server packages stay `private: true`; a test fails if one isn't.
- **`release.yml`,** by hand only (`workflow_dispatch` with `version` and `dry-run`), actions pinned by SHA, permissions `contents: write`, `packages: write`, `id-token: write`: every check; the images built, checked and pushed by digest; `npm publish` through npm's trusted publishing; the GitHub release with the changelog, digests and versions; then `docs.yml`. No npm token.
- **The dry run:** `dry-run: true` pushes the images to a `registry:2` service inside the job and runs `npm publish --dry-run`; its log is kept in `context/specs/m7-launch/demo/release-dry-run.log`.
- **`CONTRIBUTING.md`:** how to build and test, the proof rule, and that no outside code is accepted until the CLA exists (Q109), as the README says. **`NOTICE`** checked current.

## Done when

- [ ] Tests: every published package has its license, files and provenance; no server package is publishable (break-it: one made public fails); the version script sets one version everywhere.
- [ ] The dry run passed by hand, its log kept.
- [ ] `CONTRIBUTING.md` exists, and the README links it.
- [ ] Committed as `🔧 add the release workflow`.

## Comments
