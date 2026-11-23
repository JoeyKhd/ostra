# 06: API: Organization › Slack and the consent flow

Status: ready-for-agent
Builder: api
Features: F-057
Packages: `packages/api` (`routers/slack.ts` (new), `routers/notifications.ts`, `services/slack-connect.ts` (new), `runtime.ts`, `routers/index.ts`, the isolation test), `apps/web/src/app/api/slack/callback/route.ts` (new, the route only; the page is ticket 07)
Blocked by: 03, 04
Spec: `../spec.md`, section 4.6; ADR 0074

## What to build

- **`services/slack-connect.ts`:** implements `SlackConnectKit` on `adapter-slack`'s exported calls (`slackExchangeCode`, `slackRefresh`, `slackCheck`, `slackLookupByEmail`, `slackAuthorizeUrl`), with the domain's result unions; a fake in `domain/testing/` stands in for tests. It also holds the one **manifest** constant the page shows (the app's name, the two bot scopes, the redirect URL) and the two scope names, so the page and the docs read one source. Wired in `runtime.ts`.
- **`routers/slack.ts`:**
  - `status` (member): state; the workspace's and bot's names and the app's scopes when connected; the token's date and whether renewal is on; `clientId`; whether the client secret is set; whether settings lock the form and their names; the manifest text and the redirect URL; the member's own identity (`@name` and matched address, or none); the last check's words. Never a value.
  - `settings.save` (organization admin): the client ID and secret by reference, through ticket 04's use case; refuses `locked-by-settings` and `forbidden`.
  - `install.start` (organization admin) → `{ authorizeUrl, state }`; `install.complete` (`adminProcedure`, as Linear's is: the callback runs with the admin's session cookie, and the state is a second check) → `{ ok }` or a refusal in words, never echoing a code, a state or a token.
  - `disconnect` (organization admin), `check` (organization admin; `auth.test` through the kit and `lastCheckedAt`/`lastError`), `sendTest` (organization admin; matches their own identity, then one DM through the adapter; `no-slack-account` in words when unmatched), `identity.get` (member), `identity.refresh` (member; one lookup).
- **The callback route** `apps/web/src/app/api/slack/callback/route.ts`: mirrors the Linear one: reads `code`, `state` or `error`, calls `slack.install.complete`, redirects to `/organization/slack` with `connected=1` or the refusal in words; `access_denied` is in words; nothing sensitive in the URL.
- **`notifications.preferences.get/.save`:** the channel list comes from the domain's `notificationChannels` (no hand-written three); `get` answers `slackOn` and the member's identity; `save`'s maximum grows by the list's length; the panel's locked box still can't be saved off.
- **Isolation:** every procedure scopes by the context's organization; another organization's installation or identity is `not-found`. The generated isolation test covers the two tables (ticket 01) and the router tests repeat it.

## Done when

- [ ] Tests named for `F-057/c1`: `status` reads the installation's public fields and never a secret; `settings.save` refuses a member and a locked form, and stores the client secret as a reference; `install.start` answers a URL carrying `client_id`, both scopes and the redirect URL, and a state only its row's nonce opens; `install.complete` with the fake kit stores the team, bot and scopes and refuses a wrong state/code/client secret in words; the callback route redirects to `/organization/slack` with `connected=1` on success and with the error on a refusal.
- [ ] Tests named for `F-057/c2`: no procedure's answer, error or audit entry carries the client secret, the bot token or the refresh token; `sendTest` and `status` report only "set"/"not set".
- [ ] Tests named for `F-057/c5`: `identity.get` answers the matched row or none; `identity.refresh` does one lookup and caches it; `sendTest` for an unmatched admin answers `no-slack-account` in words.
- [ ] Tests named for `F-057/c8`: `notifications.preferences.get` lists the `slack` channel for every choosable moment (off by default), `save` stores a `slack` choice, and another organization's installation/identity is `not-found` on every procedure.
- [ ] Tests named for `F-057/c7`: `check` records `auth.test`'s refusal in `lastError` in words, never Slack's body.
- [ ] Typecheck, lint and tests for `packages/api` and `apps/web` (the route's test) pass, with the whole-repo checks.
- [ ] Committed as `✨ connect Slack from the panel`.

## Comments
