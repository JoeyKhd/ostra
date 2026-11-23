# 03: Slack adapter: the client, `send`, `update` and `health`

Status: ready-for-agent
Builder: adapters
Features: F-057
Packages: `packages/adapters/adapter-slack` (new)
Blocked by: 02
Spec: `../spec.md`, section 4.3; ADR 0025, ADR 0048, ADR 0074

## What to build

A new Apache-2.0 package, `@ostra/adapter-slack`, beside `adapter-email-resend` and `adapter-jira`:

- **`SlackNotificationAdapter extends NotificationAdapter`**, one level deep, importing `@ostra/adapter-sdk`, `@ostra/protocol` and `zod` only. Options `{ apiUrl?: string; token: string; timeoutMs?: number }`; `apiUrl` defaults to `https://slack.com/api`.
- **A hand-written client on `fetch`:** `POST auth.test`, `GET users.lookupByEmail`, `POST chat.postMessage`, `POST chat.update` and `POST oauth.v2.access`, each with a timeout, an `Authorization: Bearer` header, and a Zod schema that tolerates unknown fields and checks `ok` before narrowing. Errors carry Slack's `error` code and never the response's body or the token. Exported helpers `slackCheck`, `slackLookupByEmail`, `slackExchangeCode`, `slackRefresh` and `slackAuthorizeUrl` for the API's connect kit and core's identity matching.
- **`send(notification)`:** `unsupported` for an `account` mail (`refuseAccountMail("slack")`). For each recipient:
  - the recipient's `slackUserId` (ticket 04's field); a null one is `refused` with "The member has no Slack account", and the others go;
  - `chat.postMessage` with `channel: slackUserId`, `text` from the notification's `renderSlackDm` fields (the adapter posts `title`, `body`, `url` as plain text: heading, optional project and task lines, one line, the URL), `mrkdwn: false`, `unfurl_links: false`, `unfurl_media: false`;
  - the answer's `channel` and `ts` become `providerMessageId` `slack:<D…>:<ts>`; `channel_not_found`/`users_not_found` for one recipient is that recipient in `refused`, in words, without failing the others.
- **`update(notification, providerMessageId)`:** parses `slack:<D…>:<ts>` with a strict schema, calls `chat.update` with the closing text, and maps `cant_update_message`/`message_not_found` to `not-found`, a malformed ID to `invalid-input`.
- **`health()`:** `auth.test`; `ok` or `down` with Slack's error code in words.
- **Error mapping:** `invalid_auth`, `token_revoked`, `account_inactive`, `not_authed` → `unauthorized`; `missing_scope`, `no_permission`, `ekm_access_denied`, `is_restricted` → `forbidden`; a 429 or `ratelimited` → `rate-limited` with `Retry-After`; `internal_error`, `fatal_error`, `service_unavailable`, `request_timeout`, `team_added_to_org` → `unavailable`; `channel_not_found`, `users_not_found`, `message_not_found` → `not-found`; `cant_update_message`, `not_allowed_token_type` → `unsupported`; anything else → `invalid-response`.
- **Capabilities:** `{ channels: ["slack"], edits: true }`. The plumbing's idempotency keyed by `notification.idempotencyKey`, and a rate budget named by a digest of the token (as Linear's is).
- **The package's tests:** the notification contract suite against ticket 02's fake, plus its own cases for the ID's shape, the `D…` requirement on update, the error table, a token never in a log or an error, and `health()`.
- **`package.json`:** the workspace's shape, `"license": "Apache-2.0"`, a `test` script, no runtime dependency beyond `zod`.

## Done when

- [ ] Tests named for `F-057/c8`: the notification contract suite passes for `adapter-slack` against the fake Slack (send once per key, a refused recipient not failing the others, a rate limit, an edit where `edits` is true), and the adapter is registered nowhere in `ServerAdapters` (it is built per delivery by core, ticket 05).
- [ ] Tests named for `F-057/c5`: a post goes to a `U…` ID and the response's `D…` channel is in the returned `providerMessageId`; a recipient with no ID is refused in words and the others still receive theirs.
- [ ] Tests named for `F-057/c6`: `update` edits the bot's own message in place through `chat.update`; a `U…` ID is never used for an update; a gone message is `not-found`; a malformed ID is `invalid-input`.
- [ ] Tests named for `F-057/c7`: a 429 answers `rate-limited` with the fake's `Retry-After`, and the next send goes out; `invalid_auth`/`token_expired` maps to `unauthorized` (core retries once, ticket 05); `internal_error` is retryable and `missing_scope` is not.
- [ ] Tests named for `F-057/c4`: the post's `text` is the notification's `body` (the words `renderSlackDm` gave core), `mrkdwn` is false, both unfurl flags are false, and a title with `*`, `<>`, `@channel` and a newline reaches the fake literally.
- [ ] Tests named for `F-057/c2`: no token, code or state reaches a log record, an error message or a `SendResult` (the suite's `logs()` and the adapter's errors are asserted).
- [ ] Typecheck, lint and tests for the package pass, and `pnpm check:licenses` passes with the new Apache-2.0 package in the lockfile.
- [ ] Committed as `✨ add the Slack notification adapter`.

## Comments
