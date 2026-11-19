# 29: Images: agent images, notices, and no Anthropic file published

Status: ready-for-agent
Builder: runner
Blocked by: 08
Features: F-039, F-018
Packages: `deploy/` (`Dockerfile.agent.template` (new)), `packages/deploy-checks`
Spec: `../spec.md`, sections 2 and 7; ADR 0046 (amended), ADR 0062

## What to build

- **`pnpm check:images`** grows: a published image (server, runner, base) holds no file from an `@anthropic-ai/*` package and no `claude` binary, unless ADR 0046 records the maintainer's yes; the agent image's template holds only constants and the base digest; each image carries `THIRD_PARTY_NOTICES` generated from the packages it bundles, each with its license, and fails on a license the license check doesn't know.
- **The notices' generator** (`packages/deploy-checks`), reading the pnpm lockfile and each bundled package's `license` field and license file.
- **The runner image** carries no agent install: in a box, the agent runs in the base or agent image.

## Done when

- [ ] Tests named for `F-039`: an image with a planted `@anthropic-ai` file fails the check (break-it); the notices list every bundled package; an unknown license fails.
- [ ] The Linux proof job built the three images and an agent image for Claude Code, each started and checked, its log kept.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✅ check images for notices and agents`.

## Comments
