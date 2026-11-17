# Agent-agnostic by design, Claude Code first

**Status:** accepted (plan signed off 2026-11-17).

- **2026-11-17, first answer:** the maintainer named "claude code, opencode, ohmypi" for the first version, then added Codex: "all top tier popular coding tools should be supported".
- **Later on 2026-11-17, narrowed:** "lets focus on claude code for now only".

**v1 ships one agent: Claude Code.** The agent interface stays designed against the others from the start: OpenCode, oh-my-pi, Codex, Copilot CLI and Cursor CLI. Its event model covers what they need (`research/agent-harnesses.md`), so adding them later means writing adapters, not reworking the core. After v1 they follow in the tiers `research/agent-roster.md` recommends:
- **next:** Codex, OpenCode, oh-my-pi, Copilot CLI and Cursor CLI
- **then:** Gemini CLI and Antigravity, Kiro, Cline, Kilo Code and Goose
- **community adapters:** the rest of the ACP registry

## Consequences

- Nothing in the interface assumes Claude. Anything Claude-specific is a declared capability (adapter parity in `AGENTS.md`).
- One agent in v1 means a smaller test matrix and fewer provider terms to honor. For Claude, that's ADR 0014.
- v1 drives Claude Code through the ACP driver, as every later agent will be driven (ADR 0018).
