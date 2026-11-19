# 01: Protocol: minor 3

Status: done
Builder: core (contracts, first)
Blocked by: none (milestone 3's ticket 01, minor 2, lands first)
Features: F-110, F-111, F-037, F-098, F-104 (their wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

Every change is additive. The schema is written once, Zod first; the types are `z.infer`. If milestone 3's minor 2 isn't in yet, this ticket waits for it.

- **Minor 3,** negotiated in `hello` and `welcome`, with minor 2's codecs kept. A minor-2 peer never receives the spec's `memory` section or `agent.closingTurn`, and a minor-3 runner talking to a minor-2 server sends no `memory.used`. A minor-1 runner is outside the window.
- **Events:** `memory.used` as a runner event; `memory.proposed`, `turn.held`, `turn.released`, `review.check_updated` and `pr.related_updated` as server-only kinds, added to `serverOnlyKinds` so the gateway refuses a batch that holds one.
- **The task spec:** the optional `memory` section (`block`, `indexNoteIds`, `alwaysNoteIds`, `omitted`, `tools`) and `agent.closingTurn`. `taskSpecResponseSchemaFor(minor)` returns the shape for 1, 2 and 3; for 2 the caller has appended the block to `agent.instructions` (ticket 15), so the protocol package holds no wording.
- **The memory types** in a new `src/memory/notes.ts`: `MemoryKind`, `MemoryScope`, the note, the index entry and the proposal input as strict schemas, exported from the package root, with the branded `NoteId` and `ProposalId` in `ids.ts`.
- **Runner HTTP** in `src/runner/http.ts`: request and response schemas for `POST /tasks/:taskId/memory/search`, `GET /tasks/:taskId/memory/notes/:noteId` and `POST /tasks/:taskId/memory/proposals`, with the refusals `secret-found { found }`, `limit-reached` and `invalid`.
- **Named working values** in `limits.ts`: a note's title 120 characters and body 4 KiB, the index 100 notes and 8 KiB, the "always" notes 8 KiB, a query 500 characters, 20 results, 20 proposals a task, a search entry 8 KiB.
- The schemas' descriptions say what's never logged: a note's text, a query, a proposal's text.

## Done when

- [x] Tests: every new shape round-trips; minor-2 and minor-1 specs still parse; a minor-2 peer's codec drops `memory` and `closingTurn`; a strict object refuses an unknown field; the server-only set includes the five new kinds; the fixtures in `src/testing/` cover each new kind and endpoint.
- [x] Every caller in the repo still compiles, and no existing schema changed shape.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add protocol minor 3`.

## Comments

- 2026-11-19: built in `packages/protocol` (minor 3; `src/memory/notes.ts`; the memory endpoints in `src/runner/http.ts`; `taskSpecSchemaV2` kept for minor-2 runners; `taskSpecNeedsMinor3`; ticket 46's per-repo `gitIdentity` included, since it's minor 3's). Tests in `src/runner/minor-3.test.ts`, with break-its (dropped the minor-2 strip in `encodeTaskSpecForMinor`; dropped `turn.held` from `serverOnlyKinds`). Callers updated: task-view's fold and coverage, the domain's ingest switch, and core and runner tests that pinned minor 2 or connected at minor 1. Whole-repo typecheck, lint, test, check:licenses and check:proof green. Commit: `✨ add protocol minor 3`.
