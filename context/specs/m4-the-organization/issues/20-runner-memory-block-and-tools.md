# 20: Runner: the memory block and the memory tools

Status: ready-for-agent
Builder: runner
Blocked by: 01, 07
Features: F-110, F-111
Packages: `apps/runner` (`src/task-host/task-run.ts`, `src/sidecar/mcp-tools.ts`, `src/task-host/server-link.ts`)
Spec: `../spec.md`, sections 4 ("The memory tools") and 5.1; ADR 0044 (amended), ADR 0030

## What to build

- **At launch:** the spec's `memory.block`, rendered by core, goes to `prepareLaunch` as `memory` with `tools`, so the runner imports no Sustainable Use code (ADR 0048). The runner emits `memory.used` with `via: "index"` and `via: "always"` for the spec's two ID lists.
- **The tools** in `mcp-tools.ts`, beside `set_pull_request_text`, when `memory.tools` is true:
  - `memory_search { query, limit }`, `memory_read { noteId }`, `memory_propose { title, body, kind, scope, relatesTo?, relation? }`, each parsed with the protocol's strict schemas
  - forwarded to core's `/runner/v1/tasks/:taskId/memory/*` with the task's token, which stays in the runner's memory; the agent's bearer grants the tools and nothing else
  - a refusal from core goes back to the agent as the tool's error text; a network failure as "Memory is unavailable right now"
  - after a `memory_read`, a `memory.used` with `via: "read"`, or `"search"` when the note came from a search in the same turn
- **Never logged:** a query, a note's text, a proposal's text. Log lines carry the task ID and counts.
- **On `docker`** the server sits on the box network as it already does; the unit tests cover it against the fake engine.

## Done when

- [ ] Tests named `it("F-110: ...")`: the block reaches the fake agent; `memory.used` for the index and a read; the tools are absent when `tools` is false.
- [ ] Tests named `it("F-111: ...")`: a proposal reaches the fake core with the task token and the agent never sees it; a secret refusal's words reach the agent.
- [ ] The task token appears in no file of the workspace or the agent's folders, and in no event (searched by value).
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the memory tools to the sidecar`.

## Comments
