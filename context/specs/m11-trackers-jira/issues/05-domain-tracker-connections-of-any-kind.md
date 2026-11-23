# 05: Domain: tracker connections of any kind, boards per connection

Status: ready-for-agent
Builder: core
Blocked by: 01, 02
Features: F-152, F-008
Packages: `packages/domain` (new `use-cases/tracker-connections.ts`, `use-cases/linear-connection.ts`, `use-cases/boards.ts`, `tickets/board-mapping.ts`, `setup/timeline.ts`, `use-cases/prompt-tickets.ts`, the rules' and schedules' starts, `audit/`, `index.ts`), `context/domain-model.md`, `context/GLOSSARY.md`
Spec: `../spec.md`, sections 1, 4 and 5.4 (ticket 05's list); ADR 0071

## What to build

Section 5.4's list for ticket 05:

- **The kinds and the view:** `trackerKinds`, `comingSoonTrackerKinds`, the `TrackerConnection` union per kind, `trackerConnectionsOf`, `trackerConnectionOf`.
- **Lifecycles:** a connection's (`pending` → `active` ⇄ `failed` → `revoked`, `resumedInto`) and a board's (`attached` | `paused` with `pausedBy` | `detached`), each a discriminated union with exhaustive tests; `boardStateOf(board, connection)` the one derivation. Every reader that today checks `detachedAt === null` and a connection's state by hand reads it: ingest's poll set, ticket sync's writes, intake rules, schedules' tickets, prompt tickets (`ticketsForPromptTasks` "on but paused"), the Inbox's starts, agent mode's board lookup.
- **The move away from "the organization's Linear":** `ConnectionTracker` moves to `tracker-connections.ts` and gains `kind` and `name`; `startLinearConnection` always makes a new named pending row; `isPendingAppId`; `attachBoard({ projectId, connectionId, externalId })` for any active connection; no `findFirst` by kind remains in `packages/domain` (a test greps the source for `kind: "linear"` outside Linear-only files, as milestone 4's seams test greps).
- **Names and one site per connection:** `defaultConnectionName`, `connectionNameSchema`, `name-taken`, `siteTakenBy`.
- **Resume:** `resumeBoardsInTx`, with `tracker.resumed`.
- **Jira's mapping:** `doneBy` `ostra` by default where the adapter declares `transitions`; `mappingReachability(workflow, mapping)`; `movedNot`'s words for the progress comment.
- **The setup step:** `tracker` replaces `linear`, done on `tracker.connected` or `linear.connected`; skipping writes both columns.
- **The audit actions** of section 5.4.
- **Docs in the same commit:** `domain-model.md` draws both lifecycles. `GLOSSARY.md` already has **Tracker connection**, **Paused board** and **Target status** (the spec's commit); a meaning the build changes is updated there.

## Done when

- [ ] Tests named for `F-152/c1`: two Linear and two Jira connections in one organization, each named, listed by `trackerConnectionsOf` with their kinds and capabilities; a second pending Linear connection is allowed.
- [ ] Tests named for `F-152/c2`: `siteTakenBy` finds the holder; a name already used is `name-taken`; a revoked holder doesn't block.
- [ ] Tests named for `F-152/c3`: with two connections of one kind, attach, ingest's poll set, ticket sync and rules each use the board's own connection, and a `ConnectionTracker` of one never serves another's board (break-it: look the tracker up by kind, and the test fails).
- [ ] Tests named for `F-152/c4`: `attachBoard` takes boards of two connections, of two kinds, into one project; a non-active connection's board is refused.
- [ ] Tests named for `F-152/c5`: a disconnected or failed connection's boards are `paused`; rules, schedules, prompt tickets and ticket sync skip them; `resumeBoardsInTx` moves the paused boards and their tickets of a revoked connection of the same site to the new one, and no other's.
- [ ] Tests named for `F-152/c7`: the `tracker` step is done with any active connection (either kind), open or skipped otherwise; an organization that skipped `linear` reads skipped.
- [ ] Tests named for `F-008/c7`: a Jira board's drafted mapping moves Done by ostra; `mappingReachability` gives each step's line and its unreachable statuses.
- [ ] Checks for `packages/domain` and its direct consumers pass, and the whole-repo checks (spec section 10).
- [ ] Committed as `✨ hold tracker connections of any kind`.

## Comments
