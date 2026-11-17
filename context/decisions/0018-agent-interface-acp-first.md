# One agent interface, with ACP first

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3, following the recommendation in `research/agent-harnesses.md`.

- **ostra's own driver interface and event model**, shaped like ACP, typed as discriminated unions and checked with Zod.
- **The first driver is one generic ACP driver.** It covers every agent that speaks ACP, natively or through an adapter.
- **Each agent has a native profile** for launching it, its logins, and saving and restoring sessions (ADR 0006).
- **Agent-specific drivers** are added only where a test shows ACP falls short, for example steering mid-turn through oh-my-pi's RPC or OpenCode's HTTP API.

## v1: Claude Code through ACP

v1 ships Claude Code only (ADR 0004), and it still goes through the ACP driver: the runner speaks ACP to `@agentclientprotocol/claude-agent-acp`. That adapter is Apache-2.0, maintained by the ACP organization and built on Anthropic's Agent SDK, which runs the unmodified Claude Code binary.

The maintainer, asked whether to drive the Agent SDK directly instead: "keep acp i guess, its the most extensible later on as well". With ACP from day one, the second agent is a new profile, not a new driver.

## Consequences

- ostra depends on the adapter's releases as well as Claude Code's. The runner image pins both, and a test suite runs against the pinned pair.
- Steering mid-turn uses the adapter's `_session/steering` extension, a capability ACP v1 lacks (`research/agent-harnesses.md`).
- A spike confirms two things before building on this:
  - a member's own Claude subscription works through the adapter on their own runner, within Anthropic's terms (ADR 0014)
  - approvals that wait for hours survive
- The runner image pins each agent's version, and tests run against those versions.
- Agent event schemas tolerate unknown event types. Vibe Kanban's OpenCode adapter broke on a new one (`research/landscape.md`).
- Adding a top-tier agent that speaks ACP takes one profile, not one driver (ADR 0004).
