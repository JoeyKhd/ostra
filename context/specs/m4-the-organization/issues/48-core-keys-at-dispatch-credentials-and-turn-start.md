# 48: Core: keys enforced at the dispatch, the credentials and every turn start

Status: resolved
Builder: core
Blocked by: 12 (the turn starts it gates), 45
Features: F-135, F-089, F-088, F-037
Packages: `packages/domain` (`src/use-cases/dispatch-task.ts`, `issue-task-credentials.ts`, `create-prompt-task.ts`, `tickets.ts`, `hold-provider.ts`, `ingest-events.ts`, `task-profile.ts`), `apps/core` (`src/dispatch/task-spec.ts`, `src/dispatch/endpoints.ts`, every turn start ticket 12 gates, `src/catalog/`)
Spec: `../spec.md`, sections 4 ("Keys per project") and 5.5; ADR 0065

## What to build

Today every one of these reads the provider through the profile (`profile.model.provider`). After this ticket each reads the session's recorded row, and checks it against the project's list.

- **A session's start** calls `resolveSessionModel` and records `providerId` and `modelId` on the session. A task that can't resolve stays queued with `no-provider-for-model`, and a needs-you item for the organization's admins. `create-prompt-task` and the ticket start refuse with the same reason before they create anything, and the New task check reads the same function.
- **The task spec** takes the session's model row (`agent.providerId`, `modelId`, `endpointModelId`, `apiFormat`), not the profile's, and the spend cap's prices come from the same row.
- **Dispatch** doesn't send a session whose recorded provider isn't on its project's list (`provider-not-allowed`).
- **The credentials endpoint** (`issueTaskCredentials`) reads the provider from the session's row and checks it is on the project's list now, before it reads the token. Otherwise it refuses with `provider-not-allowed`, an audit entry `task.credentials-refused`, and a log line with IDs only.
- **Every turn start** calls `providerGate` beside `budgetGate`, inside the task's lock. `moved` starts the turn in a fresh box (F-033's path), on the new provider; `none` holds the message with the reason, as a closed budget does.
- **A list change** enqueues `providers.release-boxes`, which releases the project's idle boxes holding a key the change removed. A running turn's box is released after its turn.
- **Caps and holds by the session's provider:** the cap of sessions at once counts sessions with that `providerId` in every project; `provider.rate_limited` holds the session's recorded provider; personal runners are checked against the resolved provider in the dispatch, the prompt task and the ticket start. None of them moves a task to another provider.
- **Spend:** `usage.recorded` is priced from the session's model row and attributed to its provider, and `SpendDaily` (ticket 12) is keyed by that row. An event naming another provider is logged `usage.provider-mismatch` and counted against the session's own.
- **The model refresh** (`src/catalog/`) runs `keepChoicesOnRefresh` for every list the provider is on, in the refresh's transaction.

## Done when

- [x] **The isolation test,** named `it("F-135: a task in one project never gets the token of a provider allowed only in another")`:
  - two projects, two providers serving one model by name, each provider on one project's list
  - a task in each gets its own provider in its spec and its credentials
  - with the first task's session row edited to name the second provider, the dispatch doesn't send it, the credentials endpoint refuses it with an audit entry, and no response body holds the second token (searched by value, never printed)
- [x] **Its break-it,** recorded in `context/proof/F-135.md`: the list check removed from the credentials endpoint fails the test, and so does the one removed from the dispatch.
- [x] Tests named `it("F-135: ...")`:
  - a turn start after a list change, for `open`, `moved` and `none`
  - idle boxes released at once, and a running turn finishing first
  - a rate limit, a cap and an endpoint error each leave the task on its provider
  - the cap counted across projects, and personal runners refused in every project
  - spend per provider, priced from each provider's own row, and the mismatched usage event
  - New task's refusal, and a ticket task's queued reason with its needs-you item, seen by organization admins and not by members
- [x] The whole-repo checks pass (credentials, spec section 9).
- [x] Committed as `✨ enforce keys per project`.

## Comments

- 2026-11-19, `✨ enforce keys per project`: a session's start resolves its provider and model row through the project's list (`resolveProfileModelInTx`, `packages/domain/src/providers/session-model.ts`) in `createPromptTask`, `startTicketTask` and the dispatch, and records them; the dispatch, the task spec, the credentials endpoint (with `task.credentials-refused` in the audit log and an IDs-only log line), the spend and the rate-limit hold read only the session's row. A turn start (`sendMemberMessageInTx`, `tasks.send` on an idle session) runs the provider gate before the budget gate: `moved` and `none` start a fresh session (`restartOnProviderChangeInTx`, `providers/turn-start.ts`), whose dispatch takes a fresh box or waits with `no-provider-for-model` and a needs-you item for organization admins, closed again once a provider serves the model. `providers.release-boxes` runs in core (`apps/core/src/cleanup/cleanup.ts`, `releaseProviderBoxes`): idle boxes at once, a running turn's box on a later run after its turn. The model refresh calls `keepChoicesAfterRefreshInTx` in its transaction. The organization's first provider joins the default list. Tests: `apps/core/src/dispatch/keys-per-project.test.ts`, `packages/api/src/routers/keys-at-start.test.ts`; 13 break-its in `context/proof/F-135.md`. Proved with the fake adapters and a stub second key; the live two-key run is ticket 55. Left to others: the New task page's words and the wait codes' panel copy (ticket 53), spend per provider on screen (tickets 27, 50), and the needs-you row's words.
