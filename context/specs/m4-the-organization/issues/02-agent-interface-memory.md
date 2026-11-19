# 02: Adapter SDK: memory for agents

Status: done
Builder: adapters (contracts, first)
Blocked by: 01
Features: F-110, F-111, F-098, F-073 (the canary control)
Packages: `packages/adapter-sdk` (`src/agent/`, `src/testing/`, `src/test-adapters/`)
Spec: `../spec.md`, section 5.2; ADR 0044 (amended), ADR 0035

## What to build

- **The capability** `memory: "mcp" | "index-only"` on `AgentCapabilities`, declared by every agent adapter (OpenCode: `mcp`).
- **The launch input:** `PrepareLaunchInput` gains `memory: { block: string, tools: boolean } | null`, the block as the spec carries it (core renders it with ticket 06's renderer). The base class documents that the block goes with the profile's instructions in the task's own config folder, never in a repo.
- **Native memory, off** (ADR 0044, Q91): the base class documents that an adapter turns its agent's own memory feature off at launch, so nothing an agent keeps for itself outlives the task, skips a member's approval or differs from runner to runner (on `host`, Claude Code's auto memory would carry from task to task on one machine). Each adapter's class says what it turns off, or that its agent has none; OpenCode has none (ticket 07). The Claude Code adapter will set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and the contract case for this rule (no memory the agent wrote is left outside the task's folders after a session) comes with it, the first agent that has native memory.
- **The fakes:** the scripted fake agent gains steps that call `memory_search`, `memory_read` and `memory_propose` on the MCP server its config names; a new index-only fake declares `memory: "index-only"` and lists no MCP server. A fake core for the sidecar's memory endpoints (`@ostra/adapter-sdk/testing`), answering by the protocol's schemas, with a search over a fixture list and a proposal counter.
- **The agent contract suite gains:**
  - the block reaches the agent (the fake reports its instructions) and no repo (`git status` clean in each)
  - with `mcp`, the three tools are offered and each call round-trips through the fake core; with `index-only`, none is offered and the block still arrives
  - two repos checked out side by side, the agent at the workspace root, its instructions listing both
  - if milestone 1's suite doesn't have it, ADR 0035's canary: a file outside the workspace, a scripted shell call that reads it, and the event log showing the call with its full input (ported from spike 10's reach check)

## Done when

- [x] The suite passes against both fakes, and against OpenCode once ticket 07 is in.
- [x] The base class's doc comment states the native-memory rule, and both fakes state that they have none.
- [x] Tests named for their rows, e.g. `it("F-110: an agent without MCP gets the index and no tools", ...)`, with break-it checks, and rows added to `context/proof/F-110.md` and `F-073.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add memory to the agent interface`.

## Comments
- 2026-11-19, adapters (contracts): done in `✨ add memory to the agent interface` (COMMIT), on ticket 01's protocol minor 3. **Contract:** `AgentCapabilities.memory: "mcp" | "index-only"`, declared by every adapter (OpenCode `mcp`, the tiny agent `index-only`); `PrepareLaunchInput.memory?: { block, tools } | null` (`LaunchMemory`, optional so a caller without memory compiles); `composeLaunchInstructions(input)`, the one text an adapter writes in the task's config folder: the profile's instructions, the repos side by side when there are several (F-098), then the block. The base class's doc comment states the native-memory rule; the fakes and OpenCode say they have none. **Fakes:** the scripted fake agent's config gains `ostraMcp`, and its scripts `instructions`, `memory-tools`, `memory-search`, `memory-read`, `memory-propose` (real JSON-RPC calls to the MCP server its config names) and `shell-read` (the canary); `new FakeAgentAdapter("plain", undefined, undefined, "index-only")` is the third fake, which never lists ostra's MCP server (the profile's own MCP servers still reach it). `startFakeMemoryCore` (`@ostra/adapter-sdk/testing`) answers `runnerPaths.taskMemorySearch`, `taskMemoryNote` and `taskMemoryProposals` by the protocol's schemas (a search over `memoryNoteFixtures`, a proposal counter with the cap), with the task's token, and a stand-in for the sidecar's MCP server on `/mcp` (`initialize`, `tools/list`, `tools/call`) that calls those endpoints as the sidecar will (ticket 20). **Suite** (`agent-memory-cases.ts`, called from `defineAgentContractSuite`, each case skipped without its probe): the block reaches the agent with the profile's instructions, every launch file outside the repos and `git status` clean in each; with `mcp`, the three tools offered and each call round-tripping through the fake core; with `index-only`, the block and no tool; two repos side by side with the agent at the root and its instructions naming both; and ADR 0035's canary, which milestone 1's suite lacked. They pass on the rich, plain and index-only fakes; OpenCode's fixture has no memory probe until ticket 07. Proof: `context/proof/F-110.md` (three rows `partial`, the native-memory row `missing` until the Claude Code adapter) and `F-073.md` (the event log row `partial`). Break-it checks: dropped the block from `composeLaunchInstructions`; gave the index-only fake the MCP server; stopped counting searches at the fake core; replaced a tool call's input with `{}` in `map.ts`. Each failed its cases.
