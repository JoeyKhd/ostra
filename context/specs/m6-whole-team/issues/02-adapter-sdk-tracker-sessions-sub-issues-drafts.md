# 02: Adapter SDK: agent sessions, people, sub-issues and draft writes

Status: done
Builder: adapters
Blocked by: none
Features: F-012, F-077, F-099, F-040
Packages: `packages/adapter-sdk` (`src/tracker/`, `src/testing/fake-linear/`, `src/testing/jira-fake.ts`, `src/testing/tracker-suite.ts`, `src/test-adapters/tiny-adapters.ts`)
Spec: `../spec.md`, section 5.2 (`TrackerAdapter`)

## What to build

Each operation lands with its implementation in the Jira fake and the tiny adapter in the same commit (adapter parity, `AGENTS.md`). Linear's implementation is ticket 07.

- **Agent sessions,** behind the existing `agentSessions` capability: `parseAgentSessionEvent`, `postAgentActivity` (idempotent by its key) and `setAgentSessionLink`, as spec section 5.2 gives them. The Jira fake declares `agentSessions: false` and its methods return `unsupported`. A stop is an event the adapter parses, never a method.
- **`agentScopes`** on the capabilities: the scopes agent mode needs (Linear: `app:assignable`, `app:mentionable`), so core can see that a stored token lacks them.
- **People:** `getUser(userId)`.
- **Sub-issues:** `createTicket` takes an optional `parent`; `getTicketContext`'s children carry `open`. The Jira fake models sub-tasks under a parent, one level deep, and its `subIssues` stays true.
- **Draft writes:** `updateTicket(board, ref, { description })`; `attachFile` behind `attachments`; the capability `ticketFields: { acceptanceCriteria: boolean }` (Linear false; the Jira fake true, as a field of its own).
- **The fake Linear server** grows agent sessions, ported from spike 5's fake: a delegation (`delegateId` on create or update) and a mention make a session and send a signed `AgentSessionEvent` `created`; a thread reply sends `prompted`; a stop sends `prompted` with `signal: "stop"`; activities are recorded with their kind and ephemeral flag; the staleness clock marks a session stale after 30 minutes without an activity and recovers on the next; a personal key's `agentActivityCreate` gets the 403 the real run saw; the OAuth authorize honours `update_scopes_on_existing_token`.
- **The tracker contract suite** gains the cases of spec section 5.2.

## Port from

`spikes/linear-agent-mode/src/fake-linear/` (agent sessions, `rules.ts`, the activity record).

## Done when

- [x] The contract suite's new cases pass on the Jira fake and the tiny adapter, each optional capability's absence declared and tested; they pass on Linear's adapter against the fake server once ticket 07 lands.
- [x] The fake's staleness rule has a test with and without activity, and the 403 for a key has one.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add agent sessions and sub-issues to trackers`.

## Comments

- 2026-11-20: built in `✨ add agent sessions and sub-issues to trackers`. Every milestone 6 operation is a method on `TrackerAdapter` that answers `unsupported` until an adapter overrides it, so Linear's adapter still compiles before ticket 07. New capabilities: `agentScopes` (empty without `agentSessions`), `agentSessionLink` (a declared `false` where the tracker has no link) and `ticketFields.acceptanceCriteria`; `TicketUpdate` takes `acceptanceCriteria` only where that field is true (`invalid-input` elsewhere), and `Ticket.acceptanceCriteria` reads it back. `getTicketContext`'s children are `ChildTicket`s with `open` (Linear's adapter derives it from the status category already). The suite's new cases pass on the Jira fake (people, sub-tasks one level deep, draft writes, attachments, sessions declared absent) and the tiny tracker (each absence, `getUser`); on Linear's adapter only the capability case runs until ticket 07 passes `milestone6: true` to `fakeLinearSuiteFixture`, which turns on the people, sub-issue, draft and session cases against the fake Linear's new sessions. The staleness rule (with and without activity), the 403 for a key, `update_scopes_on_existing_token` and the delegation's need for `app:assignable` are tested in `fake-linear.test.ts`; `context/proof/F-012.md` cites them as partial, with the live run's plan.
