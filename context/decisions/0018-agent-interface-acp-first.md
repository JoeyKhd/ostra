# One agent interface, with ACP first

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3, following the recommendation in `research/agent-harnesses.md`. Amended 2026-11-18: ostra's own ACP driver stands, and Rivet Sandbox Agent is not used (ADR 0032). The v1 section is now OpenCode, with Claude Code on keys as the second agent in milestone 7. Steering mid-turn is a declared capability (Q45, Q51, Q52, Q103).

- **ostra's own driver interface and event model**, shaped like ACP, typed as discriminated unions and checked with Zod.
- **The first driver is one generic ACP driver,** built on the official ACP SDK (`@agentclientprotocol/sdk`) over stdio. It covers every agent that speaks ACP, natively or through an adapter.
- **Each agent has a native profile** for launching it, its provider and permission config (which ostra writes for each task), and saving and restoring sessions (ADR 0006). No subscription login is used, stored or passed on for any agent. The agent gets a fake key, and the key proxy swaps in the real one (ADR 0030).
- **Agent-specific drivers** are added only where a test shows ACP falls short, for example steering mid-turn through oh-my-pi's RPC or OpenCode's HTTP API.
- **Steering mid-turn is a capability an agent declares,** never assumed (F-024). An agent without it, such as OpenCode over ACP, gets a queued message, delivered when the turn ends. "Interrupt and send" is a separate, explicit action that cancels the turn and sends the message as the next prompt. An agent with the capability gets the message mid-turn.

## v1: OpenCode through ACP

v1 ships OpenCode, the default and the only agent from milestone 1 (Q45, F-019). It goes through the ACP driver, which runs in the box's sidecar and speaks ACP to `opencode acp`. OpenCode takes any model through a base URL, a key and a model ID, which is how ostra treats every model provider (ADR 0033).

- The base image pins OpenCode's version and verifies its checksum.
- OpenCode over ACP can't steer mid-turn. Spike 1 records whether OpenCode's own HTTP API can. Until it does, OpenCode doesn't declare the capability.
- The contract suite also runs a scripted fake ACP agent that declares what OpenCode lacks, such as steering mid-turn. That keeps the agent interface honest with one real agent.

**Claude Code ships before launch, in milestone 7, as the second agent (F-018).** It runs on provider keys through the key proxy, never on a subscription login, so it needs an endpoint that speaks Anthropic's Messages API, which the key proxy already supports. It goes through the same driver as one more profile. The planned route is the ACP adapter `@agentclientprotocol/claude-agent-acp` (Apache-2.0, maintained by the ACP organization, built on Anthropic's Agent SDK), confirmed when F-018 is built. Two real agents prove that the interface is agent-neutral. Codex stays later (F-038).

The maintainer, asked whether to drive the Agent SDK directly instead: "keep acp i guess, its the most extensible later on as well". With ACP from day one, the second agent is a new profile, not a new driver.

## Consequences

- ostra depends on OpenCode's releases and on the ACP SDK's. The base image pins each agent's version (and, from milestone 7, the Claude Code adapter's), and a contract suite runs against the pinned versions.
- Steering mid-turn isn't part of ACP v1 (`research/agent-harnesses.md`). Each agent declares it where it has it, through an extension or its own API. For Claude Code in milestone 7, the adapter's `_session/steering` extension may supply it.
- Spike 1 (`how-should-the-runner-drive-opencode`) and spike 2 (`can-a-session-move-to-a-fresh-box`) confirm this before milestone 1 builds on it. If plain ACP fails one of spike 1's must-haves, the driver uses OpenCode's HTTP API for that capability. If that fails too, the choice of default agent is reopened.
- Every agent-specific import lives in one package, and ostra's own event model sits between it and the rest of the code.
- Agent event schemas tolerate unknown event types. Vibe Kanban's OpenCode adapter broke on a new one (`research/landscape.md`).
- Adding a top-tier agent that speaks ACP takes one profile, not one driver (ADR 0032).
