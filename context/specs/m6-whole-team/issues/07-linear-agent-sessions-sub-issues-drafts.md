# 07: Linear adapter: agent sessions, sub-issues, drafts and users

Status: ready-for-agent
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

- [ ] Ticket 02's contract suite passes against the fake Linear server, with the new cases.
- [ ] Tests against the fake: a `created` and a `prompted` event parsed, with and without `signal`, an unknown field tolerated; an activity posted twice with one key creates one; a personal key's post is refused as `unauthorized`, never retried; the re-authorization URL's parameters; a three-level tree; a file attached.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add agent sessions and sub-issues to Linear`.

## Comments
