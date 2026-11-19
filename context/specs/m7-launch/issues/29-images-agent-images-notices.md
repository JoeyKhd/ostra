# 29: Images: third-party notices

Status: ready-for-agent
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

- [ ] Tests named for `F-039`: the notices list every bundled package (break-it: a bundled package left out fails); an unknown license fails.
- [ ] The Linux proof job built the three images, each started and checked, its log kept.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✅ check images for their notices`.

## Comments
