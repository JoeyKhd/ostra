# One agent interface, with ACP first

**Status:** accepted (plan signed off 2026-11-17). Chosen on 2026-11-17 in grilling round 3, following the recommendation in `research/agent-harnesses.md`. Amended 2026-11-18: ostra's own ACP driver stands, and Rivet Sandbox Agent is not used (ADR 0032). The v1 section is now OpenCode, with Claude Code on keys as the second agent in milestone 7. **Amended 2026-11-19:** Claude Code moves after v1, so OpenCode is the only agent at launch (ADR 0032). Steering mid-turn is a declared capability (Q45, Q51, Q52, Q103). Amended again 2026-11-18 after spike 1: OpenCode declares it, and a plan can come from a todo tool call (ADR 0032).

- **ostra's own driver interface and event model**, shaped like ACP, typed as discriminated unions and checked with Zod.
- **The first driver is one generic ACP driver,** built on the official ACP SDK (`@agentclientprotocol/sdk`) over stdio. It covers every agent that speaks ACP, natively or through an adapter.
- **Each agent has a native profile** for launching it, its provider and permission config (which ostra writes for each task), and saving and restoring sessions (ADR 0006). No subscription login is used, stored or passed on for any agent. The agent gets a fake key, and the key proxy swaps in the real one (ADR 0030).
- **Agent-specific drivers** are added only where a test shows ACP falls short, for example steering mid-turn through oh-my-pi's RPC or OpenCode's HTTP API.
- **Steering mid-turn is a capability an agent declares,** never assumed (F-024). An agent with the capability, which OpenCode now is, gets the message mid-turn: Send steers. An agent without it gets a queued message, delivered when the turn ends. "Interrupt and send" is a separate, explicit action for every agent that cancels the turn and sends the message as the next prompt.
- **Plans, approvals and the other optional parts are declared too.** An agent that sends no ACP plan, as OpenCode doesn't, has its todo tool mapped to the plan view by its adapter. A deny that ends the agent's turn is followed by a re-prompt from the runner (ADR 0032).

## v1: OpenCode through ACP

v1 ships OpenCode, the default and the only agent from milestone 1 (Q45, F-019). It goes through the ACP driver, which runs in the box's sidecar and speaks ACP to `opencode acp`. OpenCode takes any model through a base URL, a key and a model ID, which is how ostra treats every model provider (ADR 0033).

- The base image pins OpenCode's version and verifies its checksum.
- OpenCode 2.3.2 steers mid-turn over ACP, through the `_session/steering` extension that `initialize` advertises as `_meta.steering.supported`. The adapter declares `steerMidTurn` only when that flag is true, and the contract suite runs a steer probe on every OpenCode bump, because the extension is undocumented (spike 1, ADR 0032). OpenCode's own HTTP API can steer too, and stays the fallback.
- The contract suite also runs a scripted fake ACP agent that declares what OpenCode lacks, which is native plan updates and reject-and-continue, and one that can't steer. That keeps the agent interface honest with one real agent.

**Claude Code comes after v1, as the second agent (F-018).** *Changed 2026-11-19: it was to ship in milestone 7, before launch, and the maintainer moved it after v1 (ADR 0032).* It runs on provider keys through the key proxy, never on a subscription login, so it needs an endpoint that speaks Anthropic's Messages API, which the key proxy already supports. It goes through the same driver as one more profile. The planned route is the ACP adapter `@agentclientprotocol/claude-agent-acp` (Apache-2.0, maintained by the ACP organization, built on Anthropic's Agent SDK), confirmed when F-018 is built (ADR 0062, postponed). Until then, the scripted fake agents keep the interface agent-neutral with one real agent. Codex stays later (F-038).

The maintainer, asked whether to drive the Agent SDK directly instead: "keep acp i guess, its the most extensible later on as well". With ACP from day one, the second agent is a new profile, not a new driver.

## Consequences

- ostra depends on OpenCode's releases and on the ACP SDK's. The base image pins each agent's version (and, once F-018 is built after v1, the Claude Code adapter's), and a contract suite runs against the pinned versions.
- Steering mid-turn isn't part of ACP v1 (`research/agent-harnesses.md`). Each agent declares it where it has it, through an extension or its own API. OpenCode has it through `_session/steering`. For Claude Code, after v1, the adapter's `_session/steering` extension may supply it, and the contract run records what it does.
- Spike 1 (`how-should-the-runner-drive-opencode`) has run: the driver worked on OpenCode 2.3.2, and the three gaps it found (no plan, a deny that ends the turn, detached processes) have answers in ADR 0032, so the default agent stands. Spike 2 (`can-a-session-move-to-a-fresh-box`) is still to confirm the restore. If plain ACP fails one of the must-haves still open, the driver uses OpenCode's HTTP API for that capability. If that fails too, the choice of default agent is reopened.
- Every agent-specific import lives in one package, and ostra's own event model sits between it and the rest of the code.
- Agent event schemas tolerate unknown event types. Vibe Kanban's OpenCode adapter broke on a new one (`research/landscape.md`).
- Adding a top-tier agent that speaks ACP takes one profile, not one driver (ADR 0032).
