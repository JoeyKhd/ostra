# Claude Code over ACP, on keys, as the second agent adapter

**Status:** postponed: Claude Code is after v1 (the maintainer, 2026-11-19: "I think we agreed to only use Open Code, which is perfectly fine. So perhaps we can just skip Claude Code with its ACP for now."). F-018 moved from milestone 7 to after v1, so nothing in v1 builds this ADR, and its text below stays as written for when F-018 is built; it's checked again then, against the Claude Code of that day. Q250 to Q253, Q264, Q265, Q266 and Q267 wait with it. It was accepted on 2026-11-19, on the maintainer's delegation for milestone 7's spec. Settles Q250, Q251 and Q252. Covers F-018. Builds on ADR 0018 (ACP is the agent interface), 0025 (an adapter is one class, one level deep, with its contract suite), 0030 (no credential in the agent's container; a base URL and a placeholder key), 0032 (OpenCode first, ostra's own ACP driver, Claude Code in milestone 7), 0033 (any base URL and token, in either API format), 0044 (each agent's own memory stays off), 0046 (the base image pins every v1 agent) and 0049 (declared capabilities; a repo's agent config hidden when the profile can't win over it). The facts are in `research/claude-code-acp.md`. **Amended 2026-11-19 by the spec's review** (`research/claude-code-acp.md`, section 6): the launch's Node, the subagent model forced, the Windows variables, the hardening keys in `settings.json`, "always allow", subagents' stamps and plans, and a `host` machine's managed policy (Q267).

Claude Code is milestone 7's second agent. Its job is to prove that the agent interface holds for two real agents, so it adds nothing to the interface that only it needs, and everything it lacks is a declared capability.

## The adapter

- **`@ostra/adapter-claude-code`** (`packages/adapters/adapter-claude-code`, Apache-2.0): `ClaudeCodeAdapter extends AgentAdapter`, registered as `claude-code`, through ostra's own ACP driver like OpenCode. No second driver, and no use of the Agent SDK's TypeScript API: the interface stays ACP-only (ADR 0018).
- **What it launches:** `@agentclientprotocol/claude-agent-acp`, pinned exactly at 0.108.1 (Apache-2.0), which pins Anthropic's Agent SDK at 0.3.326, whose per-platform package holds the Claude Code binary. The command is `<node> <prefix>/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --hide-claude-auth`, an argument array, never a shell line, where `<node>` is the runner's own Node (`process.execPath`) on `host` and the base image's in a box, never the first `node` on `PATH`.
- **Checked before it runs:** the SHA-256 of the platform package's `claude` binary, pinned in the adapter per platform, as `adapter-opencode` pins OpenCode's. A mismatch refuses the launch. The pins are computed from the registry's packages when the version is bumped, never from the download being checked (ADR 0046).
- **`CLAUDE_CODE_EXECUTABLE` is never set.** With it, the ACP adapter puts the session's MCP servers, headers included, on the CLI's command line, where other users of the machine can read them. ostra's MCP bearer is in a header. Without it the adapter finds the binary in the SDK's platform package, and passes MCP servers over stdin.
- **`--hide-claude-auth` on every launch.** The ACP adapter then refuses every session a claude.ai subscription would pay for, and offers no claude.ai login. A member logged in to Claude Code on their own machine can't spend that login through ostra (Q47).

## Keys, through the key proxy

The agent's whole environment is an allowlist (ADR 0030):

| Variable | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | The key proxy's address: loopback on `host`, the sidecar's in a box |
| `ANTHROPIC_API_KEY` | The task's placeholder key. Claude Code sends it as `x-api-key`, which the key proxy already swaps |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` | The profile's model ID, all five, so background calls and subagents ask the endpoint for a model it serves |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | `1`: without it, a model the agent passes when it spawns a subagent, or a repo agent definition's `model:`, outranks `CLAUDE_CODE_SUBAGENT_MODEL` (research, D6). Needs Claude Code 2.1.257; the pinned SDK bundles 2.1.326 |
| `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME` | A folder in the task's agent folder, and the fixed name `task`, so nothing touches the machine's `~/.claude` and the transcript's folder doesn't depend on the workspace's path |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` (ADR 0044) |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER` | `1` (ADR 0021: no telemetry; ADR 0046: the version is the pin) |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | `false`: no predicted prompt per turn, which costs tokens and serves no one |
| `CLAUDE_AGENT_ACP_PROTOCOL` | `v1`, the version ostra's driver speaks |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` only when the profile's agent options say so, for a gateway that refuses pre-release `anthropic-beta` values. Off by default |
| `HOME`, `USERPROFILE`, `TEMP`, `PATH` and the platform's own (`SystemRoot`, `ComSpec`, `PATHEXT` and the rest on Windows) | As OpenCode's launch sets them (`adapter-opencode/src/config.ts`): the task's own home and temp folders |
| `CLAUDE_CODE_GIT_BASH_PATH` | Windows only: the `bash.exe` of the Git for Windows install whose `git` the runner runs, so the Bash tool works as elsewhere; without one Claude Code uses PowerShell, and the runner says so (research, D7) |

`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, every `CLAUDE_CODE_USE_*` provider switch and every cloud credential are never set. With discovery off, Claude Code never calls `GET /v1/models`; it does send a best-effort `HEAD /api/hello` warm-up, which the key proxy answers and doesn't count (research, D3). The provider must speak Anthropic's Messages API (`apiFormat: anthropic-messages`, ADR 0033): a Claude Code profile can choose only such a provider's models, and the domain refuses any other.

## What it writes for a task

In `CLAUDE_CONFIG_DIR`, the task's own folder, never the repo:
- `CLAUDE.md`: the profile's instructions and milestone 4's memory block. The repo's own `CLAUDE.md` or `AGENTS.md` still loads as the repo's (F-078).
- `settings.json`: the profile's approval rules as Claude Code's own `ask` rules, everything else allowed, the deny list ADR 0049 maps for every agent, and the profile's MCP servers in their transport. Always `disableAllHooks: true`, `disableSkillShellExecution: true` and `permissions.disableBypassPermissionsMode: "disable"`. For a review task, or a refine task whose profile doesn't allow prototyping, `deny` rules for the editing tools and for the ostra MCP tools the kind doesn't get.
- `skills/<name>/SKILL.md`: the profile's skills.

The repo's `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` are the adapter's `repoConfigPaths`. The ACP adapter loads the project and local setting sources, hooks included, so the runner hides those three files from the agent for the task and puts them back before the commit (ADR 0049, Q171). The repo's `CLAUDE.md`, `.claude/skills/`, `.claude/commands/` and `.claude/agents/` stay visible: they're the repo's instructions, as `AGENTS.md` is. Their frontmatter can declare hooks, inline shell, MCP servers, a permission mode and pre-approved tools (research, D8), which the three keys above turn off; if the agent suite shows a repo agent's `mcpServers` or `permissionMode` still wins over the user settings, `.claude/agents/` joins `repoConfigPaths` and this ADR says so.

**"Allow for this task"** is Claude Code's `allow_always` option, whose rule the ACP adapter writes to the repo's `.claude/settings.local.json` (research, P18). That's one of the hidden paths, so the rule holds for the task, and the runner's restore puts the original back, or removes the new file, before every commit.

**Plans and subagents.** ostra's driver advertises ACP's `plan` capability, so Claude Code sends its plans as plan operations: `plan_update` and `plan_removed`, each with a `planId` (`plan` for the session's checklist, `plan:<call>` for a subagent's, `plan-mode` for an approved plan-mode plan). The shared mapping reads them beside the legacy `plan` (milestone 7's ticket 02); without that, `nativePlan` can't pass. A subagent's tool calls, messages and thoughts come in the parent session stamped `_meta.claudeCode.parentToolUseId`. The adapter reads the stamp, or the plan ID's suffix, into `parentToolCallId`, and a subagent's plan never replaces the task's (research, section 6).

**On `host`, a machine's managed Claude Code policy** (a `managed-settings.json`, a macOS configuration profile, a `Policies\ClaudeCode` registry value) outranks every setting ostra writes and can't be hidden (research, D5). The runner reports Claude Code `failed: unsupported` on such a machine, with that reason, so a task never runs there differently from a box (Q267). A box has no such policy.

## Its capabilities

Declared as the agent contract suite proves them. Until a case passes on the real Claude Code with the stub model, its capability reads the safe value (in brackets), as OpenCode's did.

| Capability | Claude Code | How |
|---|---|---|
| `steerMidTurn` | yes | `_meta.steering.supported`, over `_session/steering` (v1) |
| `sessionLoad` | yes | `loadSession` |
| `nativePlan` | yes (no) | Its to-do list arrives as ACP plans |
| `rejectAndContinue` | yes (no) | A denied call goes back to the model; the suite shows the turn carries on |
| `elicitationForm`, `elicitation` | yes | `AskUserQuestion` as a form elicitation; ostra's driver advertises forms |
| `modelBaseUrlAndPlaceholderKey` | yes | Above |
| `sessionArchive` | yes (no) | The transcript folder, archived and restored with `tar` as an argument array, then `session/load` |
| `permissionRules` | `native` (`runner-only`) | `ask` rules in `settings.json`; the runner checks every request either way |
| `planMode` | `session-mode` | `session/set_mode` to `plan`, and back to `default` |
| `skills` | yes (no) | `skills/` in `CLAUDE_CONFIG_DIR` |
| `mcp` | HTTP and stdio | `mcpCapabilities.http`; stdio is mandatory in ACP |
| `projectConfigOverride` | no | The three repo files above are hidden instead |
| `memory` | `mcp` | ostra's MCP tools; auto memory off |

Every agent-touching feature of milestones 1 to 6 works on it through those capabilities; milestone 7's spec, section 6, lists each one.

## Where the binary comes from (Q252)

Claude Code is proprietary: Anthropic's legal agreements govern it, and its packages say "SEE LICENSE". Whether ostra may put it in the public images it publishes is a legal question for the maintainer (Q266, ADR 0032, `research/rivet.md` R16), and this ADR doesn't answer it. It makes the design work either way:

- **No image ostra publishes holds an Anthropic file** until the maintainer records, in ADR 0046, that the terms allow it. `pnpm check:images` fails if one does.
- **On `host`** (personal runners and `host` pools), the runner installs the pinned package into its own data folder the first time a task needs Claude Code, with `npm install --ignore-scripts` at the exact version, then checks the binary's SHA-256. `ostra agents install claude-code` does it ahead of time. The member's or the admin's machine downloads it from npm, under Anthropic's terms, as it would install Claude Code itself.
- **On `docker` and `kubernetes`**, the runner builds an **agent image**: `FROM` the base image, with the pinned install and the checksum check, through the snapshot builder milestones 3 and 5 already have (a Docker build, or BuildKit and the organization's registry on `kubernetes`). It's built once per base image digest and agent version, kept by the runner or in the registry, and used for every Claude Code box after it. A project's snapshot builds on it. The first Claude Code task waits with "Preparing Claude Code on this runner" while it builds; no box downloads anything when it starts (ADR 0046).
- **If the maintainer later confirms the terms allow it,** the published base image includes the pinned install, and the agent image is skipped for it. The code path stays, for agents whose terms never will.
- **A runner reports the agents it has** (each with its version, and `preparing` while one is being made), so core never offers a Claude Code task to a runner that can't run it, and says why a task waits.

## Considered options

- **The Agent SDK's TypeScript API directly**, as `agent-harnesses.md` once suggested for a TypeScript ostra. Rejected: a second way to talk to an agent, against ADR 0018; the ACP adapter is built on the same SDK and maintained upstream.
- **The ACP adapter's standalone executables** from GitHub releases. Rejected: a second download channel with its own checksums, and both the base image and every runner already have Node.
- **`CLAUDE_CODE_EXECUTABLE` pointing at a checked copy.** Rejected: MCP headers on the command line.
- **ACP's `providers/set` to route the model.** Not used: the environment does it, and a provider set over ACP blanks `ANTHROPIC_API_KEY`.
- **Claude Code in the published base image now.** Rejected until the terms are checked: a public image is redistribution.
- **A dependency of the `ostra` CLI's npm package.** Rejected: every install, including those that never use Claude Code, would download about 371 MB.
- **A subscription login on personal runners.** Rejected by Q47: keys everywhere.

## Consequences

- F-018's "done when" is met by this adapter, the agent suite on it, and a live run on an endpoint in Anthropic's format (milestone 7's demo).
- A bump of the ACP adapter re-runs the agent suite and the steer probe, and recomputes the checksums, in one commit.
- An install that wants Claude Code on `docker` or `kubernetes` pays a one-time image build per runner or registry. The docs say so.
- The ACP adapter and the Agent SDK are a dependency ostra builds on, installed at run time rather than listed in a `package.json`. ADR 0007 records it, pending the maintainer's yes.
- If Anthropic changes its terms for running Claude Code inside a product (`research/agent-harnesses.md` §1.4), this ADR is reopened.
