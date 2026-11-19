# 08: Runner: installing agents, agent images and reporting them

Status: ready-for-agent
Builder: runner
Blocked by: 01, 02
Features: F-018, F-014, F-015, F-093 (their agents)
Packages: `apps/runner` (`src/agents/` (new), `src/cli/`, `src/connection/`, `src/task-host/`), `packages/adapters/adapter-executor-docker`, `packages/adapters/adapter-executor-kubernetes`
Spec: `../spec.md`, sections 4 and 5.1; ADR 0062; ADR 0046 (amended)

## What to build

- **On `host`:** `prepareAgent(adapter)` runs `npm install --ignore-scripts --no-audit --no-fund --prefix <OSTRA_AGENTS_DIR>/<agent>/<version> <package>@<version>` with `--registry <OSTRA_NPM_REGISTRY>`, through the async child-process API, as an argument array; then `verifyAgentBinary`. A half-done install is removed; two tasks asking at once share one install. The binary's checksum is checked again before every launch.
- **On `docker`:** the agent image through milestone 3's snapshot builder, from a Dockerfile generated from `imageInstall(baseDigest)`, tagged `ostra-agent-<agent>:<version>-<baseDigest short>`, kept by the runner. **On `kubernetes`:** milestone 5's BuildKit pod and the organization's registry, by digest. `OSTRA_AGENT_IMAGE_CLAUDE_CODE` set uses that image instead. A Claude Code box uses the agent image (or a project snapshot built on it) as its agent container's image.
- **`OSTRA_AGENT_PREPARE`:** `auto`, `manual` or `off`, as spec section 5.4 says.
- **Reporting:** `agents` on `hello` and `status`; the three events; `agent.prepare` handled; an offer for an agent it can't run or prepare declined with `agent-missing`.
- **`ostra agents list`** and **`ostra agents install <agent>`**.
- **The launch record,** in development and test only: the command, arguments and environment's variable names of each agent launch, for the demo's checks; never a value, never in production.

## Done when

- [ ] Tests named for `F-018`: an install against the fake registry succeeds and is reported `ready`; a checksum mismatch, a missing platform package and a registry that's down each report `failed` with their reason and leave nothing half-installed; two tasks share one install; the agent image's Dockerfile holds only the constants and the base digest; the image builds against the fake engine and the fake BuildKit; an offer for a missing agent with `OSTRA_AGENT_PREPARE=off` is declined `agent-missing`; the launch record holds names only.
- [ ] `ostra agents install claude-code` installs the real pinned package here, and its checksum matches.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ install agents and build agent images`.

## Comments
