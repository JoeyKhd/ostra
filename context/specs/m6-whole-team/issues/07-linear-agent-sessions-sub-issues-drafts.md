# 07: Linear adapter: agent sessions, sub-issues, drafts and users

Status: done
Builder: adapters
Blocked by: 02
Features: F-012, F-077, F-099, F-040
Packages: `packages/adapters/adapter-linear`
Spec: `../spec.md`, sections 4 ("Linear agent mode", "Sub-issues", "A refine task") and 5.2

## What to build

GraphQL over `fetch`, as milestone 2's adapter is; no `@linear/sdk` (Q219).

- **Agent sessions:** `parseAgentSessionEvent` for `created` and `prompted`, reading loosely with a Zod schema that tolerates unknown fields (the vendor owns the format), including `agentActivity.signal`; `postAgentActivity` through `agentActivityCreate` with the content type per kind and `ephemeral`, idempotent by looking up the session's activities for ostra's key before it posts (milestone 2's marker rule, F-046); `setAgentSessionLink` where the API has a field for it, and a declared `false` where it doesn't.
- **The agent scopes:** `authorizeUrl` takes extra scopes and `update_scopes_on_existing_token=true`, so "Turn on agent mode" re-authorizes the existing install; `checkAppToken` returns the granted scopes.
- **Users:** `getUser` through `user(id)`, returning the address only when the token can read it.
- **Sub-issues:** `createTicket` with `parentId`; `getTicketContext` returns each child's state type as `open`; a tree three levels deep in at most one query per level.
- **Draft writes:** `updateTicket` through `issueUpdate(description)`; `attachFile` through `fileUpload` then the upload and `attachmentCreate`, with milestone 2's 10 MiB cap.
- **The ready status:** `listStatuses` already gives each status's type; `defaultReadyStatus(statuses)` returns the first `unstarted` one by position, for the board's mapping draft.
- Tokens go in one header and nowhere else; a session's prompt, a comment and a description are never logged.

## Port from

`spikes/linear-agent-mode/src/webhook-schema.ts` (the session event, loose), `src/linear-api.ts` (the activity call), `src/thread-reply.ts` (a follow-up as a thread reply, for the harness).

## Done when

- [x] Ticket 02's contract suite passes against the fake Linear server, with the new cases.
- [x] Tests against the fake: a `created` and a `prompted` event parsed, with and without `signal`, an unknown field tolerated; an activity posted twice with one key creates one; a personal key's post is refused as `unauthorized`, never retried; the re-authorization URL's parameters; a three-level tree; a file attached.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add agent sessions and sub-issues to Linear`.

## Comments

- 2026-11-20 (from ticket 02): the base class answers `unsupported` for every new operation, so this ticket overrides `parseAgentSessionEvent`, `postAgentActivity`, `setAgentSessionLink`, `getUser`, `updateTicket` and `attachFile`, sets `agentSessions: true`, `agentScopes: ["app:assignable", "app:mentionable"]` and `agentSessionLink`, and passes `milestone6: true` to `fakeLinearSuiteFixture` in `linear-adapter.test.ts` to run the new suite cases. The fake Linear's sessions need an install with the agent scopes: `fake.mintToken("app", [..., "app:assignable", "app:mentionable"])`. Its session JSON (`agentSession(id)`, with `activities` and `externalUrls`), `user(id)`, `issueCreate`'s `parentId` and `delegateId`, `agentActivityCreate` (a repeated client-made `id` is the same activity) and `agentSessionUpdate(externalUrls)` are answered.
- 2026-11-20 (ticket 07, commit `✨ add agent sessions and sub-issues to Linear`): built in `packages/adapters/adapter-linear` (`agent-sessions.ts`, `thread-reply.ts`, `linear-adapter.ts`, `queries.ts`, `app/oauth.ts`), with the fake Linear's `fileUpload` and signed upload target in `packages/adapter-sdk/src/testing/fake-linear/`. Proved in `agent-mode.test.ts` and by the tracker suite with `milestone6: true`; rows in `context/proof/F-012.md`, `F-040.md`, `F-077.md` (new) and `F-099.md`, all `partial` until core and the panel finish them. Differences from the ticket's words:
  - **`checkAppToken` doesn't return the scopes.** Linear's API has no field that reads a token's scopes back (spike 5: "the scopes are those in the token response, not read back"). The granted scopes are the token answer's (`LinearTokenSet.scopes`, kept by core with the install), and `missingAgentScopes(granted)` says which agent scopes they lack.
  - **"A tree three levels deep in at most one query per level"** holds as one `issue` query per `getTicketContext`: the interface reads one ticket's context at a time (ticket 02 kept milestone 2's shape), so core's walk (ticket 12) reads one context per ticket. The test reads a three-level tree in three queries.
  - **An activity's idempotency:** its client-made `id` is a UUID derived from the session and the key (`activityIdFor`), looked up among the session's activities before the post and again when Linear refuses it, so a retry after a lost answer posts nothing more.
  - `getUser` reads the address when the token can, and reads the rest without it when Linear refuses the field. The test is named F-040, for core's member match.
  - The live run waits for the maintainer's Authorize click (ticket 40); its plan is in `context/proof/F-012.md`.
