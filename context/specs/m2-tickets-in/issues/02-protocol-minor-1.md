# 02: Protocol: minor 1

Status: done
Builder: core (contracts, first)
Blocked by: none
Features: F-096, F-033, F-047, F-068, F-114, F-064 (their wire shapes)
Packages: `packages/protocol`
Spec: `../spec.md`, section 5.1

## What to build

Every change is additive. The schema is written once, Zod first; the types are `z.infer`.

- **Minor 1,** negotiated in `hello` and `welcome`, with minor 0's codecs kept: a minor-0 peer never receives a `release` command or the new spec fields, and a minor-1 runner talking to a minor-0 server sends none of the new events.
- **Events:** `session.saved`, `session.limit_reached` and `ticket.files_ready` as new union members; `session.restored` gains its optional `origin`, `replayedUpdates` and `hiddenRef`; `user.message` gains an optional `replayed`. The read side keeps its `unsupported` row for a kind it doesn't know.
- **The command `release { taskId, boxId }`,** in `commandBodySchemas` and `commandKindSchema`.
- **The task spec:** `ticket`, `contextFiles`, `restore` and the new `limits` fields, all optional, so a spec without them parses. A `taskSpecResponseSchemaFor(minor)` returns the shape for a negotiated minor.
- **The bulk path:** request and response schemas for the four blob endpoints, added to `runnerPaths`, each with the lease epoch, and the 409 answer for a stale one.
- **Named working values** in `limits.ts`: idle 15 min, session maximum 120 min, stall 10 min, upload chunk 1 MiB, archive cap 64 MiB.
- The schemas' descriptions say what's never logged: an archive's bytes, ticket text, the pending messages' text.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **Three more optional event fields,** for the reopen and limits targets (spec section 5.1):
  - `session.restored.previousBox: "kept" | "released" | "lost"`
  - `user.message.reopen: true` on the message a reopen wrote
  - `session.crashed.cause: "agent_exited" | "box_lost"`
  Each is optional, and the fixtures cover both the present and the missing case.

## Done when

- [x] Tests: every new shape round-trips; a minor-0 spec still parses, and a minor-0 peer's codec drops the new fields; a strict object refuses an unknown field; an unknown event kind reads as `unsupported`; the fixtures in `src/testing/` cover each new kind.
- [x] Every caller in the repo still compiles, and no existing schema changed shape.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add protocol minor 1`.

## Comments
- 2026-11-19, core (contracts): done in `✨ add protocol minor 1`. `PROTOCOL_MINOR` is 1, with minor 0's codecs kept beside it (`taskEventSchemaV0`, `runnerEventSchemaV0`, `commandSchemaV0`, `taskSpecSchemaV0`). Senders check `eventKindSupportedAt` and `commandKindSupportedAt` before they make a minor-1 event or a `release`; the minor-0 encoders drop the new fields (`encodeEventForMinor`, `encodeTaskSpecForMinor`). The runner now sends `x-ostra-minor` on the spec request, and core answers in that minor's shape (`minorFromHeader`; no header reads as 0). The bulk path's bodies are in `src/runner/blobs.ts`, with `offset-mismatch`, `digest-mismatch` and `too-large` added to the HTTP error codes. `release` carries a `reason` (`prs-closed`, `idle-expired`, `task-deleted`, `requested`) for the executor's `release`. The DB's `CommandKind.release` came in this commit, in its own small migration (`20261119200000_command_release`), because `packages/db`'s enum map wouldn't compile without it; ticket 05 has the rest. Callers: the runner answers `release` with `done`/`not-held` for a box it no longer runs, or `rejected`/`box-busy` (ticket 23 replaces it); ingest stores the three new kinds and does nothing else yet (tickets 17, 19, 26); the fold gives them no row until ticket 36's targets.
