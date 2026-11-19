# 29: API: memory notes, proposals and the task's memory

Status: resolved
Builder: api
Blocked by: 15, 16
Features: F-109, F-110, F-111
Packages: `packages/api` (`src/routers/memory.ts` (new), `src/routers/tasks.ts`)
Spec: `../spec.md`, section 4 ("A proposal's decision"); ADR 0044 (amended)

## What to build

- **`memory.notes({ scope, projectId?, query?, kinds?, status? })`:** a scope's notes, searched with full-text when `query` is set, with kind, "always", source, author, version, last used (the last read, ADR 0044, Q91) and use count; the proposals' count for the scope.
- **`memory.note(noteId)`:** a note with its versions (who, when, the proposal it came from).
- **`memory.save` / `memory.archive`:** ticket 16's use cases; a secret refusal is a `BAD_REQUEST` with `found` (the kind), never the value. An edit takes `expectedVersion`, and a stale one is `CONFLICT` with who saved and which version (ADR 0044, Q91).
- **`memory.proposals({ scope, projectId? })`** and **`memory.proposal(id)`:** with the source task's title and link, the declared relation, and the three related notes.
- **`memory.decide(id, decision)`:** approve as new, approve and archive a note, merge into a note with the merged text and the note's `expectedVersion` (`CONFLICT` when it moved on), or reject.
- **`memory.rememberThis({ diffCommentId } | { prCommentEventSeq, taskId })`:** ticket 16's "Remember this".
- **`tasks.memory(taskId)`:** the notes each session used and how, and the proposals the task made with their states.
- **The profile's switch:** milestone 3's agent profile procedures gain `closingTurn`.

## Done when

- [x] Tests named `it("F-109: ...")`, `it("F-110: ...")` and `it("F-111: ...")`: each procedure's access per scope (a member who can't open a restricted project gets `NOT_FOUND` for its notes); a search; a secret refusal's shape; a stale save's and a stale merge's `CONFLICT`; each decision; `tasks.memory` lists what the session's `MemoryUse` rows say.
- [x] Committed as `✨ add memory to the API`.

## Comments

- 2026-11-19 (api builder B): built and pushed as `✨ add memory to the API`, in `packages/api/src/routers/memory.ts`: `memory.notes`, `memory.note`, `memory.save`, `memory.archive`, `memory.proposals`, `memory.proposal`, `memory.decide`, `memory.rememberThis` and `tasks.memory`, over ticket 16's use cases. A refusal is a tRPC error whose message carries what the panel shows: a secret refusal is `BAD_REQUEST` naming the kind (never the value), a stale save or merge `CONFLICT` naming who saved which version (the router has no error formatter, so these are words, not fields). `rememberThis` drafts from a diff comment's text when no title and body are given; an `@ostra` comment's text is only in the member message, so the panel sends the member's edited text for it. `agentProfiles.save` takes `closingTurn` (kept when absent) and `get`/`list` return it; `SaveAgentProfileInput` gains the optional field. Tests: `packages/api/src/routers/memory.test.ts` and the isolation suite's memory rows; break-its in `context/proof/F-109.md`, `F-110.md` and `F-111.md`.
