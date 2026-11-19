# 06: Claude Code adapter: the package, its pins, its launch and its environment

Status: wontfix
Note: Won't do now (2026-11-19): Claude Code (F-018) moved after v1 (the maintainer: "perhaps we can just skip Claude Code with its ACP for now"), and milestone 7 is the launch alone, on OpenCode. This ticket waits for F-018 after v1; its text stays as written for then (ADR 0062, postponed).
Builder: adapters
Blocked by: 02
Features: F-018
Packages: `packages/adapters/adapter-claude-code` (new, Apache-2.0)
Spec: `../spec.md`, sections 4 and 6; ADR 0062; `context/research/claude-code-acp.md`
Note: the spec's review split this ticket. The files the adapter writes for a task, the task kinds, the repo's config, subagents and sessions are ticket 38.

## What to build

- **The package:** `ClaudeCodeAdapter extends AgentAdapter`, `name = "claude-code"`, one level deep (ADR 0025), with `LICENSE`, `package.json` (`license: Apache-2.0`, no Anthropic package in any dependency list) and its own vitest config.
- **The pins:** `CLAUDE_AGENT_ACP_VERSION = "0.108.1"`, the Agent SDK version it pins (`0.3.326`, which bundles Claude Code 2.1.326: the SDK's `claudeCodeVersion`), and the SHA-256 of each platform package's binary (`claude`, or `claude.exe` on Windows), computed from the registry's packages (not from a download the install is checking), with a script `scripts/pin-checksums.ts` that recomputes them on a bump and prints the diff.
- **`install`:** `{ kind: "npm", package: "@agentclientprotocol/claude-agent-acp", version, binary, sha256ByPlatform }` and `imageInstall`.
- **`requires`:** `["anthropic-messages"]`. **`optionsSchema`:** `{ stripExperimentalBetas: boolean }`, which sets `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`.
- **`prepareLaunch`:** the argument array `<node> <prefix>/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --hide-claude-auth`, where `<node>` is the runner's own `process.execPath` on `host` (never a `node` looked up on `PATH`) and the base image's Node in a box; `cwd` the workspace; and exactly ADR 0062's environment:
  - the five model variables set to the profile's model, and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, so neither a model the agent passes when it spawns a subagent nor a repo agent definition's `model:` outranks it (research, D6);
  - the platform variables and the task's own home and temp folders exactly as `adapter-opencode/src/config.ts` lists them (`HOME`, `USERPROFILE`, `TEMP` and, on Windows, `SystemRoot`, `ComSpec`, `PATHEXT` and the rest), not only `HOME` and `PATH`;
  - on Windows, `CLAUDE_CODE_GIT_BASH_PATH` set to the `bash.exe` of the Git for Windows install whose `git` the runner already runs, when there is one, so Claude Code's Bash tool works as on Linux and macOS. Without it Claude Code uses PowerShell (research, D7), and the runner says so on its agents line;
  - `CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, every `CLAUDE_CODE_USE_*` provider switch and every cloud credential never set, even when the runner's own environment has them.
- **`health()`:** the install present at the pinned version and its binary's checksum matching; and on `host`, no managed Claude Code policy on the machine, since one outranks every setting ostra writes (research, D5): the file-based `managed-settings.json`, `managed-settings.d/` and `managed-mcp.json` in the platform's system folder; on Windows a `Settings` value under `HKLM` or `HKCU` `SOFTWARE\Policies\ClaudeCode`, read with `reg query` as an argument array; on macOS the `com.anthropic.claudecode` managed preferences domain. A policy found reports `unsupported` with the reason "this machine's managed Claude Code policy would apply to its tasks", never the policy's content. The paths are injectable for the test.
- **Capabilities:** ADR 0062's table, each `true` value behind a constant `VERIFIED_CASES` that ticket 07 fills; until a case passes on the real agent, the safe value.

## Done when

- [ ] Tests named for `F-018`: the launch's arguments and environment against the allowlist, with a polluted runner environment (a subscription token, `CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CODE_USE_BEDROCK`, an AWS key) that reaches nothing; `<node>` is `process.execPath`, never a `node` on a planted `PATH`; the five model variables and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; on Windows, `CLAUDE_CODE_GIT_BASH_PATH` from a fake Git install, and absent without one; `health()` refusing a changed binary and a planted managed-policy file. Each with a break-it recorded in `context/proof/F-018.md`.
- [ ] `pnpm check:licenses` passes, and the package lists no `@anthropic-ai` dependency.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✨ add the Claude Code adapter`.

## Comments

- 2026-11-19, lead: set `wontfix`. Claude Code (F-018) moved after v1 on the maintainer's word, and this ticket waits for it.
