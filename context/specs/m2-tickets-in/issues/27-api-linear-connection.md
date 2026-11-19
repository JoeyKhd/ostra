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

## Done when

- [ ] Tests against the fake Linear server: the whole flow from `start` to `active`; a callback with another admin's state, an old state or a reused state is refused; a token that isn't the app's is refused; polling mode on a private address; a member who isn't an admin is refused everywhere; secrets never come back from any procedure.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add the Linear connection`.

## Comments
