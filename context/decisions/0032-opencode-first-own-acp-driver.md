# OpenCode first, over ostra's own ACP driver

**Status:** accepted (2026-11-18, from the delegated answers in `context/history/answers-2026-11-18.md`). Supersedes ADR 0004 and ADR 0024. Settles Q45, Q51, Q52 and Q103, and covers F-018, F-019 and F-024. ADR 0018 stays as the agent interface. Its "v1: Claude Code through ACP" section is replaced by this ADR.

**Two agents before launch, behind one interface:**
- **OpenCode** is the default, and the only agent from milestone 1 (F-019).
- **Claude Code** ships before launch, in milestone 7, as the second agent (F-018 is v1). It runs on provider keys through the key proxy (ADR 0030), never on a subscription login (Q47). It needs a model provider whose endpoint speaks Anthropic's Messages API (ADR 0033), which the key proxy already supports. Its job in milestone 7 is to prove the agent interface with two real agents.
- **Codex** and the others come later, one adapter each (F-038).

OpenCode takes any model through a base URL, a key and a model ID, which is the rule for model providers (ADR 0033). One agent through milestones 1 to 6 keeps the test matrix small while the platform is built.

**The runner drives every agent with ostra's own driver:**
- The driver is built on the official `@agentclientprotocol/sdk` 2.x, over stdio, with one agent process per task, in the task's box (ADR 0029).
- Every agent-specific import lives in one runner package, behind `AgentAdapter` (ADR 0025). ostra maps ACP into its own typed event model (ADR 0018), and the panel sees only ostra's events.
- The driver advertises `elicitation.form`. Without it, OpenCode cancels its questions and tells the model to carry on without an answer (`research/rivet.md`, R13).
- OpenCode's version is pinned in the base image and its checksum is verified when the image is built. ostra writes its provider and permission config for each task. It starts the agent with an explicit environment that holds only a fake key and a base URL that points at the sidecar (ADR 0030), never the runner's own environment.
- The agent's own "always allow" is not used. "Approve for this task" is an ostra rule, and the agent is always answered "once" (ADR 0036).
- Reopening a task calls `session/load`. How the session reaches a fresh box is ADR 0039's subject.

## Steering

Steering mid-turn is a capability an agent declares (`steerMidTurn`, ADR 0025). The composer follows it (F-024):
- **An agent without it, such as OpenCode over ACP.** OpenCode runs one prompt at a time and returns an error for a second `session/prompt` while the first is active. So **Send queues** the message. Everyone sees it in the thread as "queued", and it's delivered when the turn ends. **Interrupt and send** is a separate, explicit action: it cancels the turn with `session/cancel` and sends the message as the next prompt.
- **An agent with it** gets the message mid-turn. Claude Code's ACP adapter has a steering extension on ACP v1 (`_session/steering`), and the ACP v2 draft adds `delivery: "steer" | "queue"`. Milestone 7's contract run records what Claude Code really does.

Queuing is the default because an interrupt marks the tool calls in flight as failed, and can leave an install or a migration half done (Q52). If members interrupt most of the time, the default flips per agent profile.

Until spike 1 says otherwise, OpenCode doesn't declare `steerMidTurn`. Spike 1 also records whether OpenCode's own HTTP API can steer mid-turn. If it can, that becomes an optional capability inside the OpenCode adapter, not the base.

The contract suite also runs a scripted fake ACP agent that declares what OpenCode lacks, steering first. That keeps adapter parity testable in milestones 1 to 6 (`AGENTS.md`).

## Considered options

- **Rivet Sandbox Agent** (ADR 0024). Rejected, on `research/rivet.md`:
  - Since v0.2.0 it passes raw ACP envelopes through, so its "universal schema" no longer exists and it adds no normalization over plain ACP.
  - It's built on ACP SDK 0.16 while the current one is 2.7, it has had one functional fix since March, and its issues are closed as "not planned" with fixes waiting.
  - Its transport dies on turns longer than five minutes. Its `DELETE` never kills the agent. Its restore is a text replay capped at 12,000 characters that never calls `session/load`.
  - Its telemetry is on by default (ADR 0021), it passes the runner's whole environment to the agent, and it downloads agents from "latest" without checking a hash.
  - What the maintainer liked about it stays: start as many runners as you want with one key, and the work goes faster. That comes from runner pools and join tokens (ADR 0029), which Rivet never provided.
- **Claude Code first** (ADR 0004). Rejected: Claude Code is proprietary, and its API format would tie the first agent to one provider, against "any base URL works" (Q106). It ships in milestone 7 instead.
- **An agent-against-agent bake-off in milestone 0** (Q46). Replaced by spike 10: OpenCode alone, on the model in `model.env`. The Omnara arm can't change a decision, and a Claude Code arm would tie the spike to one API family.
- **OpenCode's own server and SDK as the base.** Rejected: it's OpenCode only, which breaks adapter parity, and its API broke completely between versions 1 and 2. Kept as a possible capability inside the adapter, for steering.
- **Screen-reading drivers** such as `coder/agentapi`. Rejected: no structured tool calls, diffs or permission objects, which is too lossy for ADR 0011.
- **The AI SDK's experimental agent harnesses.** Rejected: bridge harnesses need a port exposed on the sandbox, which conflicts with a runner that only dials out.
- **Six agents in v1** (`research/agent-roster.md`). Not adopted: one agent, then a second in milestone 7.

## Consequences

- ostra owns the driver. It's small, because the official SDK does the JSON-RPC, and it stays in one package. It's budgeted in milestone 1.
- Agent event schemas tolerate unknown event types, because the format belongs to the vendor (`AGENTS.md`).
- The base image pins OpenCode, and the runner image pins the ACP SDK (ADR 0046). A contract suite runs per agent version. On every bump, spike 1's cases T3, T5 and T11 run again, and so does spike 2's restore test (T12 in `research/rivet.md`).
- ACP v2 is still a draft. A v2 driver changes only the adapter, never ostra's events.
- Claude Code's license is proprietary. Its redistribution terms are checked before it goes into the public base image (`research/rivet.md` §10, R16), and that check comes before milestone 7 ships it.
- Spike 1 (`how-should-the-runner-drive-opencode`) tests only this driver. If it fails a must-have on plain ACP, the failed capability is tried through OpenCode's HTTP API, and if that fails too, the choice of default agent is reopened. The same applies if spike 10 misses its bar on two different models, or spike 2 shows an OpenCode session can't move to a fresh box.
- Rivet's agent launch table is ported in milestone 1 as a small piece of logic, with attribution. It's listed in ADR 0015's Borrowed code section and in `NOTICE` (Q21).
- F-019 is v1 in milestone 1, and F-018 is v1 in milestone 7. F-038 (Codex) stays later.
