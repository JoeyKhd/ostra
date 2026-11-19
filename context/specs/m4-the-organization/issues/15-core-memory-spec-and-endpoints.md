# 15: Core: memory in the task spec, and the memory endpoints

Status: resolved
Builder: core
Blocked by: 01, 06
Features: F-110, F-111
Packages: `apps/core` (`src/dispatch/`, `src/http.ts`, `src/ingest/`), `packages/domain` (`buildMemoryBlock`, `searchNotes`, `proposeNote`, `recordMemoryUse`)
Spec: `../spec.md`, sections 4 ("Memory at a session's start", "The memory tools") and 5.1; ADR 0044 (amended), ADR 0030

## What to build

- **The spec's `memory` section,** built at each session's dispatch from the active notes of the task's project and organization: "always" notes in full, then the index, in ADR 0044's order, cut at the limits, rendered into `block` with ticket 06's renderer, with the two ID lists and `omitted`. `tools` is true when the profile's agent declares `memory: "mcp"` and the runner speaks minor 3. A minor-2 runner gets the block appended to `agent.instructions` and no tools.
- **The repos list:** for a task with several repos, the dispatch appends ticket 06's list of repos, folders and base branches to `agent.instructions` (with ticket 17).
- **`memory.used`** from the runner is stored as `MemoryUse` rows (one per session, note and via), every one of them, in the ingest's transaction. Only `via: "read"` and `via: "search"` update the note's `lastUsedAt` and `useCount`; `index` and `always` don't, so the index doesn't keep its own notes in it (ADR 0044, Q91).
- **The endpoints** under `/runner/v1/tasks/:taskId/memory/`: each checks the task token's task and lease epoch as milestone 1's credentials endpoint does, then:
  - `search`: `searchNotes` over the task's project and organization, active notes only, bound parameters, at most 20 results
  - `notes/:noteId`: a note of that project or organization, or 404 for any other
  - `proposals`: the secret scan (with its model-control tokens), the per-task cap, the strict input, then a `MemoryProposal` with the task and session, a `memory.proposed` event in the thread, and an audit entry; a refusal answers with its code and words for the agent
- **Never in a log line:** a query, a note's text or a proposal's text. Logs carry the task's, the note's and the proposal's IDs.
- **Q91** is settled (ADR 0044, "Q91: what the prior art changed"): the index's order by last read is ticket 06's builder, the use rule above is this ticket's, and `searchNotes` stays as ADR 0044 names it.

## Done when

- [x] Tests named `it("F-110: ...")`: the section's order and cut; a minor-2 runner's folded instructions; an archived note is in neither the index nor a search; a `memory.used` with `via: "index"` or `"always"` stores its row and leaves `lastUsedAt` and `useCount` alone, while `read` and `search` move them; another project's and another organization's notes are never returned by search or read; a token for another task is refused.
- [x] Tests named `it("F-111: ...")`: a proposal is stored as `proposed` and reaches no later spec until approved; a secret or a model-control token is refused and nothing is stored; the 21st proposal of a task is refused.
- [x] Break-it checks recorded in `context/proof/F-110.md` and `F-111.md`.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add memory to the task spec and the sidecar`.

## Comments

- 2026-11-19: built and proved; committed as `✨ add memory to the task spec and the sidecar` (its hash is in the next ticket's commit, and in `git log`). `buildTaskSpec` takes the runner's minor and an agent's memory mode: a minor-3 runner gets `memory` (tools only for an `mcp` agent) and `agent.closingTurn`; a minor-2 runner gets the block, rendered without the tools, at the end of `agent.instructions`. The repos list is now the domain's `renderReposForAgent` (folders, base branches, the branch), in the project's `position` order. The three endpoints are `apps/core/src/memory/endpoints.ts`; `searchNotes`, `readNote`, `recordMemoryUse`, `proposeNote` and `buildMemoryBlock` are `packages/domain/src/memory/store.ts`, and the ingest stores `memory.used`. A refused proposal answers 200 with its refusal body, as the fake core of ticket 02 does. Twelve break-its, each caught (`context/proof/F-110.md`, `F-111.md`). The organization's secret values the scan reads are its environments' secrets and its providers' tokens.
