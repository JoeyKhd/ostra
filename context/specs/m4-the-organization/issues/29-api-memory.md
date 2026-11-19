# 29: API: memory notes, proposals and the task's memory

Status: ready-for-agent
Builder: api
Blocked by: 15, 16
Features: F-109, F-110, F-111
Packages: `packages/api` (`src/routers/memory.ts` (new), `src/routers/tasks.ts`)
Spec: `../spec.md`, section 4 ("A proposal's decision"); ADR 0044 (amended)

## What to build

- **`memory.notes({ scope, projectId?, query?, kinds?, status? })`:** a scope's notes, searched with full-text when `query` is set, with kind, "always", source, author, version, last used and use count; the proposals' count for the scope.
- **`memory.note(noteId)`:** a note with its versions (who, when, the proposal it came from).
- **`memory.save` / `memory.archive`:** ticket 16's use cases; a secret refusal is a `BAD_REQUEST` with `found` (the kind), never the value.
- **`memory.proposals({ scope, projectId? })`** and **`memory.proposal(id)`:** with the source task's title and link, the declared relation, and the three related notes.
- **`memory.decide(id, decision)`:** approve as new, approve and archive a note, merge into a note with the merged text, or reject.
- **`memory.rememberThis({ diffCommentId } | { prCommentEventSeq, taskId })`:** ticket 16's "Remember this".
- **`tasks.memory(taskId)`:** the notes each session used and how, and the proposals the task made with their states.
- **The profile's switch:** milestone 3's agent profile procedures gain `closingTurn`.

## Done when

- [ ] Tests named `it("F-109: ...")`, `it("F-110: ...")` and `it("F-111: ...")`: each procedure's access per scope (a member who can't open a restricted project gets `NOT_FOUND` for its notes); a search; a secret refusal's shape; each decision; `tasks.memory` lists what the session's `MemoryUse` rows say.
- [ ] Committed as `✨ add memory to the API`.

## Comments
