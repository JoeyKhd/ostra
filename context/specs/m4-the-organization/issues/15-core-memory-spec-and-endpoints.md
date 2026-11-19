# 15: Core: memory in the task spec, and the memory endpoints

Status: ready-for-agent
Builder: core
Blocked by: 01, 06
Features: F-110, F-111
Packages: `apps/core` (`src/dispatch/`, `src/http.ts`, `src/ingest/`), `packages/domain` (`buildMemoryBlock`, `searchNotes`, `proposeNote`, `recordMemoryUse`)
Spec: `../spec.md`, sections 4 ("Memory at a session's start", "The memory tools") and 5.1; ADR 0044 (amended), ADR 0030

## What to build

- **The spec's `memory` section,** built at each session's dispatch from the active notes of the task's project and organization: "always" notes in full, then the index, in ADR 0044's order, cut at the limits, rendered into `block` with ticket 06's renderer, with the two ID lists and `omitted`. `tools` is true when the profile's agent declares `memory: "mcp"` and the runner speaks minor 3. A minor-2 runner gets the block appended to `agent.instructions` and no tools.
- **The repos list:** for a task with several repos, the dispatch appends ticket 06's list of repos, folders and base branches to `agent.instructions` (with ticket 17).
- **`memory.used`** from the runner is stored as `MemoryUse` rows (one per session, note and via) and updates each note's `lastUsedAt` and `useCount`, in the ingest's transaction.
- **The endpoints** under `/runner/v1/tasks/:taskId/memory/`: each checks the task token's task and lease epoch as milestone 1's credentials endpoint does, then:
  - `search`: `searchNotes` over the task's project and organization, active notes only, bound parameters, at most 20 results
  - `notes/:noteId`: a note of that project or organization, or 404 for any other
  - `proposals`: the secret scan, the per-task cap, the strict input, then a `MemoryProposal` with the task and session, a `memory.proposed` event in the thread, and an audit entry; a refusal answers with its code and words for the agent
- **Never in a log line:** a query, a note's text or a proposal's text. Logs carry the task's, the note's and the proposal's IDs.
- **Q91.** If `research/project-memory.md` lands while this is built and changes how notes are found, only `searchNotes` and the index's order change; say so here under `## Comments`.

## Done when

- [ ] Tests named `it("F-110: ...")`: the section's order and cut; a minor-2 runner's folded instructions; an archived note is in neither the index nor a search; another project's and another organization's notes are never returned by search or read; a token for another task is refused.
- [ ] Tests named `it("F-111: ...")`: a proposal is stored as `proposed` and reaches no later spec until approved; a secret is refused and nothing is stored; the 21st proposal of a task is refused.
- [ ] Break-it checks recorded in `context/proof/F-110.md` and `F-111.md`.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add memory to the task spec and the sidecar`.

## Comments
