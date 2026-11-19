# 22: The three images

Status: ready-for-agent
Builder: core
Blocked by: none
Features: F-039, F-013 (the runner image), F-001 (the compose file's images)
Packages: `deploy/Dockerfile.server`, `deploy/Dockerfile.runner`, `deploy/Dockerfile.base`, `deploy/compose.yaml`, `scripts/images.ts` (new), `packages/deploy-checks` (new, private, Apache-2.0), `package.json` (`images:build`, `check:images`)
Spec: `../spec.md`, section 11, item 15; ADR 0046 (amended)

## What to build

Milestone 1's ticket 22 wrote the Dockerfiles; this ticket makes them buildable and checked.

- **The server image:** `turbo prune --docker` for `@ostra/web` and `@ostra/core`, one entrypoint (`ostra-server web|core|all`), a non-root user, a health check.
- **The runner image:** the `ostra` CLI built from `apps/runner`, as the pool runner and the sidecar, a non-root user; `ostra --version` prints the release version.
- **The base image:** the tools, OpenCode installed at its exact version with install scripts off, its platform binary's SHA-256 checked against `pinnedChecksums` from `@ostra/adapter-opencode` (in the repo, never from the download), the model catalog as a file with the fetch off, the init program; nothing downloaded when a box starts.
- **Every `FROM` pinned by digest,** and no secret in a `RUN`, `ARG` or `ENV`.
- **`pnpm images:build`** (Linux with Docker): builds the three, tagged with the release version, and prints each one's size. **`pnpm check:images`** (anywhere): the static checks, moved from `deploy.test.ts` into `packages/deploy-checks` with the YAML reader that file has, and grown to the rules above.
- Nothing is pushed anywhere. Publishing is milestone 7.

## Done when

- [ ] Tests in `packages/deploy-checks`, named for `F-039`: every `FROM` has a digest; the checksum comes from the repo's pin; no secret-shaped `ARG`; the compose file runs the images the build tags.
- [ ] Break-it: taking the checksum from the downloaded file fails its test; recorded in `context/proof/F-039.md`.
- [ ] Committed as `✨ make the three images buildable`. The live build is ticket 35's.

## Comments
