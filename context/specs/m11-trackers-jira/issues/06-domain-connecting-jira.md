# 06: Domain: connecting Jira, and a connection's changes

Status: done
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

- [x] Tests named for `F-008/c1`: against the fake kit: a site found and its cloud ID saved; `not-found`, `data-center` and `site-taken` (naming the holder) refused; a token checked with nothing stored; saved only after a pass or warnings; refused on a fail; the secret made once while pending and shown until the first delivery; `activateOnFirstDelivery` makes the connection `active` and resumes a revoked one's boards; `finishJiraPolling` activates without a secret.
- [x] Tests named for `F-008/c2`: the token reaches the secret store and the kit only: never a returned value, an audit entry, an error or a log line (searched by value).
- [x] Tests named for `F-008/c8`: `tokenExpiryState` is `expires-soon` from 14 days before the date and `expired` on it; `failConnection` fails it with its reason; `replaceJiraToken` runs the read-back first; `rotateJiraSecret` makes a new secret and the old one no longer verifies.
- [x] Tests named for `F-152/c5`: `disconnectTracker` deletes every secret of a Jira and of a Linear connection, sets it `revoked`, and its boards read `paused`.
- [x] Tests named for `F-152/c2`: a Linear authorization on a workspace another connection holds is refused, naming it, with the pending row's secrets deleted.
- [x] Tests named for `F-152/c3`: a member who isn't an organization admin is refused every use case, and `jiraWebhookOf` never answers a secret to one.
- [x] Checks for `packages/domain` pass, and the whole-repo checks (spec section 10).
- [x] Committed as `✨ connect Jira through its service account`.

## Comments

- 2026-11-23, core: built as `✨ connect Jira through its service account` (`ebb8f13b`). Tests in `packages/domain/src/milestone-11-jira-connect.test.ts` (17, on Postgres, against the fake kit), and `settings.test.ts`'s `OSTRA_JIRA_API_URL` case. Readings and differences:
  - **Where it lives:** `use-cases/jira-connection.ts` (the port `JiraConnectKit` with the domain's own unions, mirroring `adapter-jira`'s `jiraConnect` so ticket 09's service binds it field by field; `jiraTokenVerdict`, `accessCheckOf`, `jiraSiteNameOf`, `jiraWebhookUrl`, `tokenExpiryState` and every Jira use case); `use-cases/tracker-connections.ts` gains what every kind shares (`renameConnection`, `failConnection`, `revokeConnectionInTx`, `isPlaceholderConnectionName`, `trackerAdminOnly`); `startTrackerConnection` and `disconnectTracker`, which dispatch on the kind, are in a new `use-cases/tracker-connection-changes.ts`, so `tracker-connections.ts` imports neither kind's file. The fake kit is `testing/jira-connect.ts` (`createFakeJiraConnectKit`, `fakeJiraReadBack`); `testing/fake-adapters.ts` holds a `FakeSecretStore`, exempt from the class rule as the API's and core's fakes are (`eslint.config.js`).
  - **Transactions:** the use cases that call Jira (`findJiraSite`, `saveJiraToken`, `replaceJiraToken`, `recheckJiraToken`) take `db`, call the kit outside a transaction, then write in one that reads the row again and answers `changed` if it moved. The secret store is written before the transaction and its old value deleted after it; a new value the transaction didn't keep is deleted.
  - **Failures with more than a message:** `site-taken` and `workspace-taken` carry `holder` (`{ id, name }`), `token-failed` the read-back, `token-refused` the status. A missing connection is `no-connection` everywhere, so step 1's `not-found` is only the site's.
  - **Names:** a connection is created with the kind's placeholder (`Jira`, then `Jira 2`); step 1, or Linear's authorization, renames a placeholder to the site's or workspace's (`Globex Jira`), deduped (`Globex Jira 2`). A name an admin gives is kept, and refused when another holds it.
  - **Step 1** works while pending only; another site than the one found clears steps 2 and 3 (their secrets deleted). The unique index racing the check answers `site-taken` too.
  - **Step 2:** `expiresOn` on or before today is `expired-date`. `accessCheck` holds each project's permissions held (the kit answers the missing ones); `trackerAccessCheckSchema`'s key widened to 255 characters, Jira's limit. `scopes` holds the confirmed ones. `saveJiraToken` is pending only; `replaceJiraToken` is for an active or failed connection, and makes a failed one active again.
  - **Step 3:** `jiraWebhookOf` is admin only (a member is refused, so no secret reaches one); while pending, the mode follows the install's address as it is now. Making the secret is audited `tracker.secret-made`.
  - **Check again:** audited `tracker.token-checked`. Jira refusing the saved token fails an active connection (`token-refused`); passing again makes a `token-refused` connection active; `token-expired` stays failed until Replace.
  - **New audit actions** beside section 5.4's: `tracker.secret-made`, `tracker.token-checked`, `tracker.failed`. Linear's authorization and disconnect now write `tracker.connected` and `tracker.disconnected` (`data.kind` `linear`); the setup timeline reads both forms.
  - **Disconnect** ends the connection's open agent sessions (`stopped-in-ostra`) without a final response: its token goes with it. The audit entry counts the paused boards and the ended sessions.
  - **Resume** is called in the transaction that makes a connection active: `activateOnFirstDelivery`, `finishJiraPolling`, Replace or Check again on a failed one, and `authorizeLinear`.
  - **The API** maps `authorizeLinear`'s `workspace-taken` to `CONFLICT` (`routers/linear.ts`); the rest of the API is ticket 09's.

