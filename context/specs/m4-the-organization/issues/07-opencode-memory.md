# 07: OpenCode adapter: the memory block and the memory tools

Status: ready-for-agent
Builder: adapters
Blocked by: 02
Features: F-110, F-111
Packages: `packages/adapters/adapter-opencode` (`src/config.ts`, `src/opencode-adapter.ts`, its contract and live tests)
Spec: `../spec.md`, sections 4 ("Memory at a session's start") and 5.2; ADR 0044 (amended), ADR 0049

## What to build

- **The capability:** `memory: "mcp"`.
- **The block at launch:** `prepareLaunch` writes the memory block beside the profile's instructions (milestone 3's ticket 08 put them in the task's config folder, as OpenCode's instructions file there), never in a repo and never in a file OpenCode would commit. The block comes after the profile's instructions and before the repo's own `AGENTS.md`, which OpenCode reads natively.
- **The tools:** the memory tools sit on the same ostra MCP server the config already names for `set_pull_request_text`, so the config changes only in its instructions. The profile's MCP list, which wins over the repo's (ADR 0049), keeps the ostra server in it whatever the profile says.
- **The standing instruction** is one fixed paragraph in the block core renders (ticket 06), telling the agent to search memory before it guesses a convention, to propose a note when it learns something the next task should know, and to propose with `relation: "contradicts"` when the code disagrees with a note, instead of following it. The block names its notes as the organization's and the project's approved notes, each with its source (ADR 0044, Q91). Nothing else about memory is in the prompt.
- **Native memory** (ticket 02's rule, ADR 0044, Q91): OpenCode documents no memory feature (`research/project-memory.md`, section 8), so the adapter turns nothing off, and its class's doc comment says so.

## Done when

- [ ] The agent contract suite of ticket 02 passes against OpenCode on the stub models: the block reaches the agent, no repo has it, the three tools are listed and round-trip.
- [ ] Gated on `model.env`: a live run where the real model calls `memory_search` and `memory_propose` when its prompt asks, recorded in `## Comments` with the log kept in the repo.
- [ ] Committed as `✨ give OpenCode the memory block and tools`.

## Comments
