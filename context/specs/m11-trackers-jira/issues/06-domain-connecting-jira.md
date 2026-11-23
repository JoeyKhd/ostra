# 06: Domain: connecting Jira, and a connection's changes

Status: ready-for-agent
Builder: core
Blocked by: 05
Features: F-008, F-152
Packages: `packages/domain` (new `use-cases/jira-connection.ts`, `use-cases/tracker-connections.ts`, `use-cases/linear-connection.ts`'s disconnect, `settings.ts`, `testing/`), `docs/configuration.md`
Spec: `../spec.md`, sections 4 ("Connecting Jira", "A disconnect", "The token's date"), 5.4 (ticket 06's list) and 5.5; ADR 0047, ADR 0071

## What to build

- **The port** `JiraConnectKit` with the domain's own result unions, and a fake kit in `domain/testing/` with every check's outcomes.
- **The use cases** of section 5.4, each admin only, each audited, each a transaction where it writes: `startTrackerConnection`, `findJiraSite`, `checkJiraToken`, `saveJiraToken`, `jiraWebhookOf`, `finishJiraPolling`, `activateOnFirstDelivery`, `rotateJiraSecret`, `replaceJiraToken`, `recheckJiraToken`, `renameConnection`, `disconnectTracker`, `failConnection`, and `tokenExpiryState`.
- **The secret store purposes** `jira-token` and `jira-webhook-secret`. A token is passed to the kit and the secret store, never kept in a variable that outlives the call, and never in an error.
- **The webhook secret** is 32 random bytes, base64url; `jiraWebhookOf` answers it only while `firstDeliveryAt` is null, and `rotateJiraSecret` answers the new one once.
- **Disconnect** for both kinds: deletes the connection's secrets (Linear's through `disconnectLinear`, which revokes at Linear first), ends its open agent sessions, sets it `revoked` with its `appId` given back, and leaves its boards to pause by derivation (ticket 05).
- **Linear's one workspace, one connection:** the OAuth callback's use case (`linear-connection.ts`) refuses a workspace another connection of the organization holds (not revoked), deletes the pending row's secrets, and answers the holder's name and ID for the panel's message; on a workspace a revoked connection held, activation resumes its boards (ticket 05's `resumeBoardsInTx`).
- **`OSTRA_JIRA_API_URL`** in `settings.ts` with its line in `docs/configuration.md`.

## Done when

- [ ] Tests named for `F-008/c1`: against the fake kit: a site found and its cloud ID saved; `not-found`, `data-center` and `site-taken` (naming the holder) refused; a token checked with nothing stored; saved only after a pass or warnings; refused on a fail; the secret made once while pending and shown until the first delivery; `activateOnFirstDelivery` makes the connection `active` and resumes a revoked one's boards; `finishJiraPolling` activates without a secret.
- [ ] Tests named for `F-008/c2`: the token reaches the secret store and the kit only: never a returned value, an audit entry, an error or a log line (searched by value).
- [ ] Tests named for `F-008/c8`: `tokenExpiryState` is `expires-soon` from 14 days before the date and `expired` on it; `failConnection` fails it with its reason; `replaceJiraToken` runs the read-back first; `rotateJiraSecret` makes a new secret and the old one no longer verifies.
- [ ] Tests named for `F-152/c5`: `disconnectTracker` deletes every secret of a Jira and of a Linear connection, sets it `revoked`, and its boards read `paused`.
- [ ] Tests named for `F-152/c2`: a Linear authorization on a workspace another connection holds is refused, naming it, with the pending row's secrets deleted.
- [ ] Tests named for `F-152/c3`: a member who isn't an organization admin is refused every use case, and `jiraWebhookOf` never answers a secret to one.
- [ ] Checks for `packages/domain` pass, and the whole-repo checks (spec section 10).
- [ ] Committed as `✨ connect Jira through its service account`.

## Comments
