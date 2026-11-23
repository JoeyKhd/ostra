# 02: Adapter SDK: the fake Slack Web API

Status: ready-for-agent
Builder: adapters
Features: F-057
Packages: `packages/adapter-sdk` (`src/testing/fake-slack/`, `src/testing/index.ts`, the suite's Slack fixture docs)
Blocked by: none
Spec: `../spec.md`, section 4.2; ADR 0074

## What to build

An HTTP fake of the Slack Web API on loopback, in the house style of `testing/fake-jira/` and `testing/fake-email.ts`, with no dependency and test-only exports:

- **`auth.test`** (`POST /api/auth.test`): a good token answers `{ ok: true, team, team_id, user, user_id, bot_id }`; any other token `invalid_auth`; a fake-expired token `token_expired`; an inactive workspace `account_inactive`.
- **`users.lookupByEmail`** (`GET /api/users.lookupByEmail`, token in `Authorization: Bearer`): a known address answers the user object (`id`, `team_id`, `name`, `deleted: false`, `is_bot: false`); an unknown one `users_not_found`; a deactivated one `account_inactive`; a missing scope `missing_scope`; a control that answers the "custom bot users cannot use this method" refusal; a 429 with `Retry-After` on demand.
- **`chat.postMessage`** (`POST /api/chat.postMessage`): a user ID (`U…`) as `channel` opens or reuses that user's DM and the response carries its `D…` ID; a `D…` ID posts to it; the message's ID is `<channel>:<ts>`; it records `text`, `channel`, `mrkdwn`, `unfurl_links`, `unfurl_media` and a digest of the token; `channel_not_found` for an unknown user, `missing_scope` without `chat:write`, `msg_too_long` past Slack's 40,000-character cut-off (the response's `warning` says `message_truncated`); a 429 with `Retry-After` on demand.
- **`chat.update`** (`POST /api/chat.update`): replaces the text of a message the same bot posted; another bot's message is `cant_update_message`; a gone one `message_not_found`; a `U…` ID for a DM is `channel_not_found` (Slack's reference: a DM needs its `D…` ID).
- **`oauth.v2.access`** (`POST /api/oauth.v2.access`): an authorization-code exchange answers a bot token, `bot_user_id`, `team`, `app_id`, `scope`, and, when rotation is on, `expires_in` and `refresh_token`; a `grant_type=refresh_token` answers a new access token **and a new refresh token** and refuses the old refresh token once it was used; controls for `invalid_code`, `bad_client_secret`, `bad_redirect_uri`.
- **`GET /oauth/v2/authorize`**: the page the browser spec uses: it checks `client_id`, carries the `state`, and redirects to the configured redirect URL with a code (or with `error=access_denied`).
- **Controls and reads:** `url` (the base URL), `token`, `team`, `knownUsers` (`email` → Slack user ID) with a way to add, deactivate and remove one, `expireToken()`, `rotate()` (on/off), `rateLimitNext(seconds)`, `failNext(error)`, `messages()` (everything posted, newest last), `edits()` and `calls()`, and `close()`.
- **`src/testing/index.ts`** exports it; the notification suite's header notes Slack's fixture as an example (the suite itself needs no Slack case: send, refused recipient, rate limit and edit already cover it).

## Done when

- [ ] Tests named for `F-057/c6`: a post answers its `D…` channel and `ts`, and a second post to the same user reuses the same `D…`; the fake records both calls (the adapter's send-once is ticket 03's case); `chat.update` changes a message's text in place, refuses a `U…` ID for a DM and another bot's message.
- [ ] Tests named for `F-057/c5`: a known address resolves, an unknown one answers `users_not_found`, a deactivated one `account_inactive`, a missing scope `missing_scope`, and the "custom bot users" control refuses.
- [ ] Tests named for `F-057/c7`: a 429 answers with the `Retry-After` given, and the next call succeeds; a token expired by `expireToken()` answers `token_expired`, and the OAuth fake's refresh answers a new token and a new refresh token, the old one refused.
- [ ] The fake's own tests use loopback only, open one port, close it, and spawn nothing.
- [ ] Typecheck, lint and tests for `packages/adapter-sdk` pass.
- [ ] Committed as `✅ fake Slack's Web API`.

## Comments
