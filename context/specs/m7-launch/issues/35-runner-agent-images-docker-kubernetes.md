# 35: Runner: agent images on `docker` and `kubernetes`

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. Agent images exist for an agent ostra may not redistribute; OpenCode is in the base image. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: runner
Blocked by: 08
Features: F-018, F-015, F-093 (their agents), F-039
Packages: `packages/adapters/adapter-executor-docker`, `packages/adapters/adapter-executor-kubernetes`, `apps/runner` (`src/agents/`)
Spec: `../spec.md`, sections 4 and 5.1; ADR 0062; ADR 0046 (amended)
Note: split out of ticket 08 by the spec's review: ticket 08 is the `host` install and the reporting, this is the image half.

## What to build

- **On `docker`:** the agent image through milestone 3's snapshot builder, from a Dockerfile generated from `imageInstall(baseDigest)`, tagged `ostra-agent-<agent>:<version>-<baseDigest short>`, kept by the runner, once per base digest and agent version. The build runs `npm install --ignore-scripts` at the exact version and the binary's `sha256sum -c` against the adapter's pin, never a checksum from the same download.
- **On `kubernetes`:** milestone 5's BuildKit pod and the organization's registry, pushed and used by digest.
- **`OSTRA_AGENT_IMAGE_CLAUDE_CODE`** set: that image is used instead, and the runner still checks the binary's checksum in it before reporting `ready`.
- **A Claude Code box** uses the agent image (or a project snapshot built on it) as its agent container's image; nothing is downloaded when the box starts (ADR 0046).
- **Reporting:** `agent.preparing` while it builds, `agent.ready` with the digest, `agent.failed` with `build` or `registry` and a detail that names no credential.

## Done when

- [ ] Tests named for `F-018`: the agent image's Dockerfile holds only the constants and the base digest (break-it: a task field reaching it fails); the image builds against milestone 3's fake engine and milestone 5's fake BuildKit; a failed build and a refused push each report their reason; a second task for the same version reuses the image; `OSTRA_AGENT_IMAGE_CLAUDE_CODE` with a wrong binary is refused.
- [ ] The real builds run in ticket 31's Linux and kind jobs; this ticket's evidence is the fakes' tests.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ build agent images on docker and kubernetes`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
