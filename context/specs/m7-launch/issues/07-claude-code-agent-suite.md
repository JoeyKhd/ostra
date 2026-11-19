# 07: Claude Code adapter: the agent suite on the real Claude Code

Status: ready-for-agent
Builder: adapters
Blocked by: 03, 06, 08, 38
Features: F-018
Packages: `packages/adapters/adapter-claude-code` (`src/claude-code-adapter.contract.test.ts`, `src/claude-code-adapter.live.test.ts`, `evidence/`)
Spec: `../spec.md`, sections 6 and 9

## What to build

- **The contract run:** `runAgentSuite(new ClaudeCodeAdapter(...), { model: "stub" })` on the real pinned Claude Code, installed by ticket 08's code into `.data/agents/` (gitignored) once per machine, with the stub model in Anthropic's format. It runs on this machine (Windows, `host`), and in ticket 31's Linux and macOS jobs.
- **The cases the spec's review added** (ticket 03): the usage match, the frontmatter case, allow-for-this-task, the subagent's parent and plan, the subagent model, a `/` ticket, no stored credential, run on the real Claude Code. A frontmatter case that fails puts `.claude/agents/` in `repoConfigPaths` (ticket 38) and is run again.
- **Each capability decided by its case:** `nativePlan`, `rejectAndContinue`, `sessionArchive`, `permissionRules: native` and `skills` are set `true` in `VERIFIED_CASES` only when their case passes on the real agent; a failing one stays at its safe value, and its fallback case passes instead. The result goes under `## Comments` and in `evidence/agent-contract-suite.txt`, as `adapter-opencode` keeps its.
- **The steer probe** of spike 1, ported as OpenCode's is, run on every bump of `CLAUDE_AGENT_ACP_VERSION`.
- **The live run,** only with `OSTRA_DEV_ANTHROPIC_*` or the provider tested in Anthropic's format loaded (spec section 3): the suite with `{ model: "live" }`, its log kept in `evidence/` with every secret masked. Without either, the live test reports `skipped: no Anthropic-format endpoint`, and nothing is marked live.
- **Turn rates:** the live run records driver events a minute and bytes a message per turn, for ticket 26's mix.

## Done when

- [ ] The suite passes on the real Claude Code with the stub model here, with every capability at the value its case proved, recorded in `evidence/agent-contract-suite.txt`.
- [ ] The parity test (ticket 03) passes with Claude Code's entry.
- [ ] The live run's log is in `evidence/`, or its skip is recorded with the reason.
- [ ] The whole-repo checks pass (spec section 10).
- [ ] Committed as `✅ run the agent suite on Claude Code`.

## Comments
