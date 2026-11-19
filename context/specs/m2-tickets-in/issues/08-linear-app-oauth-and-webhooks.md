# 08: Linear adapter: the app, OAuth and webhooks

Status: ready-for-agent
Builder: adapters
Blocked by: 03
Features: F-005, F-042, F-046
Packages: `packages/adapters/adapter-linear` (`app/`)
Spec: `../spec.md`, sections 4 ("A webhook") and 11 (items 2 and 3)

## What to build

Pure functions and small calls, so core and api can hold the flow and the state.

- **The manifest link:** `linearAppManifest({ name, callbackUrl, webhookUrl | null })` → the URL on `linear.app/settings/api/applications/new`, with `distribution=private`, the redirect URI, and, when there is a webhook URL, the resource types `Issue`, `Comment`, `Attachment`, `IssueLabel`, `OAuthAuthorization` and `AgentSessionEvent` (spec section 11, item 3). The name falls back to `ostra` when the host holds "linear". The address pre-check, ported from spike 5, refuses loopback, private ranges, a host with no dot and `.local`, `.internal`, `.lan`, `.home.arpa`, and says why.
- **OAuth:** `authorizeUrl({ clientId, redirectUri, scopes, state, codeChallenge })` with `actor=app` and S256 PKCE; `exchangeCode` and `refreshToken` against `/oauth/token`, returning the access token, its expiry (24 h) and the rotated refresh token. A lost refresh response is retried with the old refresh token within its 30-minute window. `checkAppToken` queries `viewer` and confirms the token is the app's own user, returning the app user's ID and the workspace's ID.
- **Webhooks:** `verifyWebhook` checks `Linear-Signature` (hex HMAC-SHA256 of the raw body, compared in constant time with `node:crypto`) and the signed `webhookTimestamp` within 60 s. `parseWebhook` reads loosely: `Linear-Delivery`, the event type, the action, the issue's UUID and team, the actor's ID (so the caller can drop its own echoes), `createdAt` as a string or a date. An unknown type parses as `ignored`, never an error.
- Tokens and secrets go in one header or one form field and nowhere else: never in a log line, an error message or a URL.

## Port from

`spikes/linear-agent-mode/src/manifest.ts`, `oauth.ts`, `token-store.ts` (the app-user check), `webhook-verify.ts`, `webhook-schema.ts`.

## Decided 2026-11-19 (ticket 40)

The lead, on the maintainer's delegation, settled the open points the milestone 2 targets (`context/brand/app-targets/m2/`) and ticket 40 left. They're part of what to build:

- **The manifest asks for `authorization_code` only** (spec section 11, item 3). A client-credentials token would silently replace the consented installation, and it has no refresh token (`context/research/linear-app-token-without-consent.md`).
- **`clientCredentialsToken({ clientId, clientSecret, scopes })`, a development helper.** It sends `POST /oauth/token` with `grant_type=client_credentials`, and returns the token and its 30-day expiry, with no refresh token. It turns `unauthorized_client` ("Client does not support the client_credentials grant type") into a typed `grant-disabled` error. Test it on the fake Linear server. Nothing in the product calls it. A developer may use it once the app's "Client credentials" setting is on, to save `LINEAR_APP_TOKEN` in `linear.env`. Today the `ostra-test` app answers `unauthorized_client` (ticket 40).
- **`checkAppToken`** also returns the workspace's key and name and the app user's name, for `linear.status` (ticket 27).

## Done when

- [ ] Tests against the fake Linear server: the manifest's parameters; each pre-check refusal; authorize, exchange, refresh and a retried refresh; a token that isn't the app's refused; a signature off by one byte, a stale timestamp and a body re-serialized after parsing all refused; an unknown event type ignored; extra fields tolerated.
- [ ] The whole-repo checks pass (spec section 9).
- [ ] Committed as `✨ add Linear's app, OAuth and webhooks`.

## Comments
