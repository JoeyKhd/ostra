# 05: Domain: tracker connections of any kind, boards per connection

Status: done
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

- [x] Tests named for `F-152/c1`: two Linear and two Jira connections in one organization, each named, listed by `trackerConnectionsOf` with their kinds and capabilities; a second pending Linear connection is allowed.
- [x] Tests named for `F-152/c2`: `siteTakenBy` finds the holder; a name already used is `name-taken`; a revoked holder doesn't block.
- [x] Tests named for `F-152/c3`: with two connections of one kind, attach, ingest's poll set, ticket sync and rules each use the board's own connection, and a `ConnectionTracker` of one never serves another's board (break-it: look the tracker up by kind, and the test fails).
- [x] Tests named for `F-152/c4`: `attachBoard` takes boards of two connections, of two kinds, into one project; a non-active connection's board is refused.
- [x] Tests named for `F-152/c5`: a disconnected or failed connection's boards are `paused`; rules, schedules, prompt tickets and ticket sync skip them; `resumeBoardsInTx` moves the paused boards and their tickets of a revoked connection of the same site to the new one, and no other's.
- [x] Tests named for `F-152/c7`: the `tracker` step is done with any active connection (either kind), open or skipped otherwise; an organization that skipped `linear` reads skipped.
- [x] Tests named for `F-008/c7`: a Jira board's drafted mapping moves Done by ostra; `mappingReachability` gives each step's line and its unreachable statuses.
- [x] Checks for `packages/domain` and its direct consumers pass, and the whole-repo checks (spec section 10).
- [x] Committed as `✨ hold tracker connections of any kind`.

## Comments

- 2026-11-23, core: built as `✨ hold tracker connections of any kind` (`e646aa51`). Tests in `packages/domain/src/milestone-11.test.ts`, on Postgres (the domain's tests now take the db package's global setup, `packages/domain/vitest.config.ts`; the ones that open no database are unchanged). Readings and differences:
  - **Where it lives:** `lifecycles/m11-trackers.ts` (the connection's lifecycle and its transitions, `trackerConnectionLifecycleOf`, `boardStateOf`, `isBoardAttached`, and `attachedBoardWhere`, the same rule as a query, held to `boardStateOf` by a test over every state); `use-cases/tracker-connections.ts` (the kinds, `ConnectionTracker` with `kind` and `name`, `trackerServesBoard`, the names and sites, `trackerAccessCheckSchema`, the `TrackerConnection` view, `trackerConnectionsOf`/`trackerConnectionOf`, `resumeBoardsInTx`, `pausedBoardLine`); `setup/tracker-step.ts` (`trackerSetupStepOf`, `trackerSetupStepInTx`, and `skipSetupStep`, moved from the Linear file); `tickets/board-mapping.ts` (the draft's `transitions`, `mappingReachability`, `movedNot`).
  - **Capabilities are injected:** `trackerConnectionsOf(db, organizationId, capabilities)` takes each kind's declaration (`TrackerKindCapabilities`), since the domain builds no adapter: the API passes `LINEAR_CAPABILITIES` and `JIRA_CAPABILITIES`. It lists the connections not revoked; each board carries its project's access, so the API shows a member only the projects they may open.
  - **`trackerAccessCheckSchema`** (strict: per project its ID, key, name and the permissions it holds, and `workflowsReadable`) is defined here for the view; ticket 06 writes it.
  - **`startLinearConnection(deps, { name?, connectionId? })`:** always a new named row with `appId` `pending:<id>`, audited `tracker.connection-created` (not `linear.started`); without a name, `Linear`, then `Linear 2`…; `name-taken` (without case) and `invalid-name`; `connectionId` picks up a pending one instead.
  - **`attachBoard({ projectId, connectionId, externalId })`** looks the connection up by its ID and the organization, refuses a tracker that isn't that connection's, and any connection that isn't the organization's, a tracker's or active (`no-connection`). `saveBoardMapping` refuses a paused board (`board-paused`) and another connection's tracker.
  - **Paused, read by:** the one start (`start-task-body.ts`, so the Inbox's, bulk and sub-issue starts), `matchIntakeRules` (returns before making a run), `openAttachedTicketsInTx` (new: what a rule's dry run and a filter schedule read), prompt tickets, Create ticket, the ticket cache's boards, agent mode's board switch, and `writeTicketStepsInTx`, which writes nothing for a paused board (a detached board's tasks keep their sync). In core: the poll set and `pollBoard`, agent mode's board lookup, and the outside start.
  - **`resumeBoardsInTx(deps, { organizationId, connectionId, actor })`** reads the connection itself and does nothing unless it's active with a site; it audits only when it moved a board or named a successor. A board whose project already holds the team under the new connection stays, and a second agent-mode board for a team comes over with agent mode off. Not yet called: ticket 06 calls it where a connection becomes active.
  - **The setup step:** the timeline's `linear` is `tracker` (done on `tracker.connected` or `linear.connected`; `measure-setup` prints "Tracker connected (optional)"). `skipSetupStepInputSchema` takes `tracker` or `linear`, the panel's word until ticket 16, and both write `trackerSkippedAt` and `linearSkippedAt`.
  - **Jira's draft:** `doneBy` is `ostra` whenever the adapter declares `transitions`, its integration installed or not. The API's test that drafted `integration` through the in-memory Jira fake (standing in for Linear) now expects `ostra`, keyed `F-008/c7`; Linear's own `F-031/c3` case on the fake Linear is unchanged.
  - **Kept for later tickets, to compile:** the API's `boards.attach` still takes `teamExternalId` and passes the organization's Linear connection (ticket 10); `linear.start` keeps one Linear page's behaviour on the organization's first Linear connection, picking up a pending one through `connectionId` (tickets 09 and 14); `services/trackers.ts`'s `forConnection` stays Linear's and now names the connection; core's poll set still schedules Linear's boards only (ticket 07). Milestone 4's isolation test gains three more tracker connections in organization B.
  - **The grep:** `F-152/c3`'s source test fails on any query whose `where` names the kind `linear` outside `linear-connection.ts` and `agent-mode.ts`, Linear's own lookups by ID.
