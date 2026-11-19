# 02: Protocol: minor 1

Status: ready-for-agent
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

## Done when

- [ ] Tests: every new shape round-trips; a minor-0 spec still parses, and a minor-0 peer's codec drops the new fields; a strict object refuses an unknown field; an unknown event kind reads as `unsupported`; the fixtures in `src/testing/` cover each new kind.
- [ ] Every caller in the repo still compiles, and no existing schema changed shape.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add protocol minor 1`.

## Comments
