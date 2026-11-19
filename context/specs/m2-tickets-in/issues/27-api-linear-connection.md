# 27: API: the Linear connection

Status: ready-for-agent
Builder: api
Blocked by: 06, 08
Features: F-005, F-042
Packages: `packages/api` (`routers/linear.ts`), `apps/web` (`src/app/api/linear/callback/route.ts`, the route only), `packages/domain` (`connectLinear`, `authorizeLinear`)
Spec: `../spec.md`, sections 3 (step 1) and 11 (items 2 and 3)

## What to build

Every procedure is for organization admins only, and checks the organization (ADR 0026).

- **`linear.start`:** creates the connection as `pending`, decides the mode (a webhook URL on `OSTRA_CORE_PUBLIC_URL/webhooks/linear/<connectionId>` when the address passes the pre-check, polling otherwise, with the reason), and returns the manifest link from ticket 08.
- **`linear.saveApp`:** the client ID, the client secret and the webhook signing secret (not asked in polling mode), stored through the secret store, never returned.
- **`linear.authorizeUrl`:** creates an `OAuthState` bound to the admin's session (the `state`, and the PKCE verifier as a secret ref, 10 minutes), and returns Linear's authorize URL with `actor=app` and the scopes of spec section 11, item 3.
- **The callback route** in `apps/web`: checks the `state` against the signed-in admin's session (refused otherwise, and used once), exchanges the code, checks with `checkAppToken` that the token is the app's own user, stores both tokens and the expiry, records the workspace and the app user, sets the connection `active`, schedules `linear.refresh-token`, and returns to the connection page. Linear's error answers come back as a message on that page.
- **`linear.status`:** the workspace, the app user, the mode, the last event received, the token's health, and "webhooks silent since …" from ticket 14.
- **`linear.disconnect`:** revokes the token at Linear, deletes the secrets, sets the connection `revoked`, and removes its boards' schedules. Its boards and tickets stay, read-only.
- One Linear connection per organization in milestone 2; a second `start` while one is active is refused.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **Every `linear.*` procedure stays admin-only,** `linear.status` included. A member doesn't get the Linear page. It's `AdminOnly`, like GitHub's, and the sidebar shows Linear to admins only. Members see what they need of the connection on the boards and the Inbox (tickets 28 and 29).
- **`linear.status` is one discriminated union.** With no connection, or a `revoked` one, it answers `{ state: "none", mode, modeReason }` from the address pre-check, so the page shows the mode before `linear.start`. No separate `linear.mode` query.
- **`linear.status` fields, for every other state:**
  - `state`, `mode`, `credentialKind`
  - the workspace's key and name, the app user's name, `activatedAt`
  - the last event: its time, type and ticket key, from the newest `WebhookDelivery`; with only `lastEventAt`, the time alone
  - the access token's expiry, and `silentSince`
  - the poll interval and the reconcile interval, from `OSTRA_TRACKER_POLL_SECONDS` and `OSTRA_RECONCILE_MINUTES`, read-only
  - for a pending row: when it started, and which admin started it
  An `api_key` connection says so, and the page labels it `Personal API key (development)`.
- **`linear.refresh-token`** runs only for `app_oauth` connections. `app_client_credentials` is re-requested on a 401. `api_key` never refreshes.
- **The checklist's skip** (home-first-run target, item 2):
  - `setup.skip({ step: "linear" })`, admin only, writes `OrganizationSetting.linearSkippedAt` and `linearSkippedByMemberId`.
  - `setup.status`'s steps change from `done: boolean` to `state: "done" | "skipped" | "open"`. The Linear step adds `pending` and `failed` from the connection.
  - `next` is the first `open` step, and the progress counts done and skipped steps.
  - An `active` connection makes the step `done`, whether or not it was skipped.
  - Every caller of `setup.status` is updated in the same commit.

## Done when

- [ ] Tests against the fake Linear server: the whole flow from `start` to `active`; a callback with another admin's state, an old state or a reused state is refused; a token that isn't the app's is refused; polling mode on a private address; a member who isn't an admin is refused everywhere; secrets never come back from any procedure.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the Linear connection`.

## Comments
