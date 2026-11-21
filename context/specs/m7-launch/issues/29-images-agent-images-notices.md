# 29: Images: third-party notices

Status: done
Builder: runner
Blocked by: none (it was 08 and 35, which are `wontfix` since 2026-11-19)
Features: F-039
Packages: `deploy/`, `packages/deploy-checks`
Spec: `../spec.md`, sections 2 and 7; ADR 0046
Note: changed 2026-11-19. Claude Code (F-018) moved after v1, so this ticket keeps the notices. The agent image's template and the check that no published image holds an Anthropic file wait with F-018; they're in this file's history.

## What to build

- **`pnpm check:images`** grows: each image (server, runner, base) carries `THIRD_PARTY_NOTICES` generated from the packages it bundles, each with its license, and fails on a license the license check doesn't know.
- **The notices' generator** (`packages/deploy-checks`), from `pnpm licenses list --json` for the packages each image bundles, plus each one's license file, with no new dependency.
- **The runner image** carries no agent install: in a box, the agent runs in the base image.

## Done when

- [x] Tests named for `F-039`: the notices list every bundled package (break-it: a bundled package left out fails); an unknown license fails.
- [ ] The Linux proof job built the three images, each started and checked. *Waits for the launch-gate Proof run (the maintainer, 2026-11-21).* *Changed the same day: "its log kept" is dropped with the live-evidence logs.*
- [x] The whole-repo checks pass (spec section 10).
- [x] Committed as `✅ check images for their notices`.

## Comments

- 2026-11-20, runner: built in c45b6d23 (`✅ check images for their notices`).
  - **The notices.** Each image carries `/usr/share/doc/ostra/THIRD_PARTY_NOTICES`, written in its own build by `packages/deploy-checks/src/notices-main.ts` from `pnpm licenses list --json --recursive` of its install, with each package's license and the LICENSE, COPYING and NOTICE files it ships. The base image's also read OpenCode's npm install and the models.dev catalog's MIT notice (`deploy/notices/`, from models.dev's repo). No new dependency: the generator imports only Node, so it runs inside each build (and narrows pnpm's JSON by hand there, since Zod isn't reachable from it).
  - **What fails the build:** a license `scripts/known-licenses.ts` doesn't know (the license check's lists, moved there, plus the licenses a bundled package may carry: MIT-0, BlueOak, Unlicense, PSF/Python, AFL-2.1, Zlib, CC0, CC-BY-4.0 and the weak copyleft MPL-2.0, EPL-2.0 and LGPL-3.0-or-later, carried unmodified with their text; GPL, AGPL, SSPL and a missing license are unknown); a package in the install's store (`node_modules/.pnpm`, read on disk, not from pnpm's report) that the notices miss; and, with `--without-agent`, an OpenCode package in the install.
  - **The runner carries no agent.** It did: `@ostra/adapter-opencode` depends on `@opencode/cli` (for the host executor), so the runner's `pnpm install --prod` installed OpenCode's platform binaries. Its build now removes them, and `--without-agent` fails it if any is left; `check:images` fails an `@opencode/cli` install in its Dockerfile. The server image still carries them through `@ostra/core`; it never runs them, and dropping them there too is a follow-up, not this ticket.
  - **`pnpm check:images` grows:** a static rule per Dockerfile (`notices`: the prune and `--prod` match `imageBundles`, the generator runs with the image's name, and the final stage copies its output) and, from this checkout's install, each image's notices checked against `pnpm list` and for unknown licenses (here: server 792 packages, runner 168, base 4 plus OpenCode in its build).
  - **Tests** (`notices.test.ts`, `image-checks.test.ts`, F-039) and their break-its are in `context/proof/F-039.md`.
  - **Not done here: the Linux proof job.** This machine has no Docker. `scripts/live/docker.sh` now prints each built image's notices and checks the runner holds no OpenCode (`image-notices`, `runner-no-agent`); the maintainer's `gh workflow run Proof -f jobs=fleet` builds, starts and checks the three, and its log goes in `context/specs/m5-the-fleet/demo/linux/`. That box stays open, and the ticket `in-progress`, until then.
  - **Checks:** typecheck and lint of the whole repo through turbo (72 of 72), the tests of `@ostra/deploy-checks` (37) and `@ostra/runner` (369), the root's (77), `check:licenses`, `check:images` and `check:proof`.
- 2026-11-21, set `done` on the maintainer's word of 2026-11-21 (the Proof workflow runs only at the launch gate, "Launch gate only"): every box holds but the Linux job's build of the three images, which waits for the launch-gate Proof run (milestone 7's ticket 32).
