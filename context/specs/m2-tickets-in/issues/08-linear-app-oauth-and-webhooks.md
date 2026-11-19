# 08: Linear adapter: the app, OAuth and webhooks

Status: done
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

- [x] Tests against the fake Linear server: the manifest's parameters; each pre-check refusal; authorize, exchange, refresh and a retried refresh; a token that isn't the app's refused; a signature off by one byte, a stale timestamp and a body re-serialized after parsing all refused; an unknown event type ignored; extra fields tolerated.
- [x] The whole-repo checks pass (spec section 9).
- [x] Committed as `✨ add Linear's app, OAuth and webhooks`.

## Comments
- 2026-11-19, adapters: done in `9ec3675` (`✨ add Linear's app, OAuth and webhooks`). Everything is exported from `@ostra/adapter-linear` (`src/app/`). For tickets 13, 15, 27, 33 and 39:
  - **The manifest link:** `linearAppManifest({ name, callbackUrl, webhookUrl })` answers `{ ok, url, manifest, webhook }`: the JSON `?manifest=` form on Linear's new-app page, `distribution: private`, `grant_types: ["authorization_code"]`, `redirect_uris: [callbackUrl]`, `client_uri` the callback's origin. `webhook` says whether it went in: `included`, `none` (no URL given), or `refused` with the pre-check's `problem` and `reason`, in which case the manifest has no webhook and the connection polls. `linearAppName` falls back to `ostra` for any name Linear's schema refuses (one holding "linear" or a URL). `parseManifestLink` reads a link back.
  - **The pre-check:** `checkPublicUrl(url)` answers `{ ok, origin }` or `{ ok: false, problem, reason }`, the problems being `invalid-url`, `not-https`, `loopback`, `private-network` (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, fc00::/7, fe80::/10, and IPv4-mapped IPv6 of those), `single-label-host`, `local-suffix` (`.local`, `.internal`, `.lan`, `.home.arpa`) and `linear-host`. A quick tunnel's address passes.
  - **OAuth:** `createPkce`, `randomOAuthState`, `authorizeUrl` (`actor=app`, scopes comma-separated, S256), `exchangeCode`, `refreshToken`, `clientCredentialsToken` (development only), `revokeToken` (for disconnecting) and `checkAppToken`. Each answers a `Result` with a `LinearOAuthError` whose `code` is `invalid-grant`, `invalid-client`, `grant-disabled` (Linear's `unauthorized_client`), `not-an-app-user`, `different-app-user`, `unauthorized`, `unavailable` or `invalid-response`. Messages name Linear's error code, never a token, the secret or Linear's description. `LinearTokenSet` is `{ accessToken, expiresAt (ms), refreshToken, scopes }`; pass the `clock` so `expiresAt` follows the test's time.
  - **A lost refresh:** `refreshToken` asks again with the old refresh token when no answer came back (the network, a broken body, a 5xx), after 0.5 s and 2 s by default (`retryDelaysMs`). Linear repeats the same new pair for 30 minutes (`REFRESH_RETRY_WINDOW_MS`), so ticket 15 can do the same after a crash, as long as it still holds the old token. A refusal (`invalid_grant`) isn't retried.
  - **`checkAppToken({ accessToken, expected? })`** answers `{ appUserId, appUserName, workspaceId, workspaceKey (the URL key), workspaceName }`, refuses a person's token (`viewer.app` false), and with `expected` refuses another app user's or workspace's.
  - **Webhooks:** `verifyLinearWebhook` (the adapter's `verifyWebhook`) checks the hex HMAC of the raw bytes in constant time first, then the signed `webhookTimestamp` within 60 s either way, then `Linear-Delivery`; `signatureHash` is the SHA-256 of the signature in lower case. `parseLinearWebhook` answers `ignored` (any type but `Issue`, `Comment`, `IssueLabel` and `Attachment`, so `AgentSessionEvent` too until milestone 6), `app-revoked` (`OAuthApp` or `OAuthAuthorization` with action `revoked`, an assumption from Linear's docs: unverified), or `change` with the subject, action, issue UUID and key, team, actor, workspace and `createdAt` (a string or a number). A comment with no `actor` is attributed to its `userId`. The adapter's `parseWebhook` maps it to the interface's hint, `byOwnUser` comparing the actor with `ownUserId`. The adapter now declares `webhooks: true`.
  - **Live check, 2026-11-19:** a workspace webhook made with `webhookCreate` on team OST, to a quick tunnel, delivered an `Issue` create and a `Comment` create that both verified and parsed, with the issue and the team read; Linear's timestamp was about 2.5 s ahead of this machine's clock. The webhook and the issue were deleted and archived after.
  - **Not built here:** nothing calls `clientCredentialsToken` (ticket 40's decision); the connection's state, the encrypted tokens and the refresh schedule are tickets 27 and 15.
