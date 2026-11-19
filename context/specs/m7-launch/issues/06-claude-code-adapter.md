# 06: Claude Code adapter: launch, keys, config and capabilities

Status: ready-for-agent
Builder: adapters
Blocked by: 02
Features: F-018
Packages: `packages/adapters/adapter-claude-code` (new, Apache-2.0)
Spec: `../spec.md`, sections 4 and 6; ADR 0062; `context/research/claude-code-acp.md`

## What to build

- **The package:** `ClaudeCodeAdapter extends AgentAdapter`, `name = "claude-code"`, one level deep (ADR 0025), with `LICENSE`, `package.json` (`license: Apache-2.0`, no Anthropic package in any dependency list) and its own vitest config.
- **The pins:** `CLAUDE_AGENT_ACP_VERSION = "0.108.1"`, the Agent SDK version it pins (`0.3.326`), and the SHA-256 of each platform package's `claude` binary, computed from the registry's packages (not from a download the install is checking), with a script `scripts/pin-checksums.ts` that recomputes them on a bump and prints the diff.
- **`install`:** `{ kind: "npm", package: "@agentclientprotocol/claude-agent-acp", version, binary, sha256ByPlatform }` and `imageInstall`.
- **`prepareLaunch`:** the argument array `node <prefix>/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --hide-claude-auth`, `cwd` the workspace, and exactly ADR 0062's environment; `CLAUDE_CODE_EXECUTABLE`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and every cloud credential never set, even when the runner's own environment has them. The files in `<agentDir>/claude/`: `CLAUDE.md` (instructions and the memory block), `settings.json` (the approval rules as `ask` rules, the mapped deny list, the MCP servers in their transports), `skills/<name>/SKILL.md`.
- **`repoConfigPaths`:** `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`.
- **`mapUpdate`:** the subagent mark on a tool call becomes `parentToolCallId`; the plan arrives through the shared mapping; everything else `{ handled: false }`.
- **`modeIdFor`:** `plan` to `plan`, `build` to `default`.
- **`exportSession` and `importSession`:** `tar` over `<agentDir>/claude/projects/task/`, as argument arrays, with `stdoutTo` unused; `importSession` unpacks into the fresh box's agent folder.
- **`optionsSchema`:** `{ stripExperimentalBetas: boolean }`, which sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.
- **Capabilities:** ADR 0062's table, each `true` value behind a constant `VERIFIED_CASES` that ticket 07 fills; until a case passes on the real agent, the safe value.
- **`health()`:** the install present at the pinned version and its binary's checksum matching.

## Done when

- [ ] Tests named for `F-018`: the launch's arguments and environment against the allowlist, with a polluted runner environment (a subscription token, `CLAUDE_CODE_EXECUTABLE`, an AWS key) that reaches nothing; the config files' content for a profile with rules, skills and two MCP servers; the repo config paths; the mode IDs; the subagent mapping; the archive commands as arrays; `health()` refusing a changed binary. Each with a break-it recorded in `context/proof/F-018.md`.
- [ ] `pnpm check:licenses` passes, and the package lists no `@anthropic-ai` dependency.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the Claude Code adapter`.

## Comments
