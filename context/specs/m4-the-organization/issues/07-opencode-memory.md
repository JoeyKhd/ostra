# 07: OpenCode adapter: the memory block and the memory tools

Status: resolved
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

- [x] The agent contract suite of ticket 02 passes against OpenCode on the stub models: the block reaches the agent, no repo has it, the three tools are listed and round-trip.
- [x] Gated on `model.env`: a live run where the real model calls `memory_search` and `memory_propose` when its prompt asks, recorded in `## Comments` with the log kept in the repo.
- [x] Committed as `✨ give OpenCode the memory block and tools`.

## Comments

- 2026-11-19 (adapters builder): built and proved. OpenCode's instructions file (`instructionsText`, in the task's agent folder) now holds the profile's instructions and skills, the repos side by side and the memory block, and the config names it before the repos' own `AGENTS.md` globs, so the block sits between them (checked on the pinned 2.3.2 by the order case). ostra's MCP server is written with `codemode: false`: without it OpenCode 2.3.2 puts the server's tools behind its one `execute` tool and the model never sees `ostra_memory_search` by name (one config change beyond the instructions, found by the suite). A profile still can't name a server `ostra` (`checkProfileInputs`, milestone 3). The suite's memory cases pass on both stubs. Two shared fixes in `@ostra/adapter-sdk/testing`: the fake core answers a `GET /mcp` with 405, as MCP lets a server without a stream (OpenCode opens one after `initialize`), and the suite's tool-call check reads a call's title as well as its input, since OpenCode names an MCP tool in the title. Live run on the development model (`model.env`): the model called `memory_search` and `memory_propose` when asked, log in `packages/adapters/adapter-opencode/evidence/f-110-memory-live.txt`. Proof rows in `context/proof/F-110.md` (still partial for tickets 15 and 20).
