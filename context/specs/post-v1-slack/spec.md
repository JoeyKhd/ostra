# F-057: Slack notifications, per member

**Status:** spec, 2026-11-23. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Feature:** F-057 (Slack), `later` in the ledger, first in `build-order.md`'s "After v1, in this order". This spec is written before v1 ships; nothing here is built until the maintainer starts it.
**Decisions it builds on:** ADR 0025 (everything is an adapter), 0048 (the license split), 0050 (notifications, their audiences and what a message may carry), 0053 (organizations and isolation), 0035 and 0037 (the event log, the durable queue), 0007 (mail providers; Slack is its own channel). **New for this spec:** ADR 0074 (Slack notifications per member), which records the install choice (a Slack app installed by OAuth, not an incoming webhook), the destination (a DM, not a channel), and the member's identity (email matching, cached).
**Primary sources for every Slack claim:** `chat.postMessage`, `chat.update`, `users.lookupByEmail`, `auth.test`, `oauth.v2.access`, "Installing via OAuth authorization code flow", "Using token rotation", "Sending messages using incoming webhooks" and "Rate limits", all on `docs.slack.dev`; the sections below cite the page a claim comes from.
**Builds on milestones 1 to 11** as they were built, not only as they were specified. Where their code ends up different from their specs, this spec follows the code.

Terms follow `context/GLOSSARY.md`. **Slack installation** and **Slack identity** are new; the orchestrator adds them to the glossary with this spec (they are not edited here, as shared files belong to the orchestrator).

---

## 1. What this feature ends with

An organization installs ostra's Slack app once. Every member then finds a fourth column on Account › Notifications: the moments they already get in the panel and by mail can also reach them as a direct message from ostra's bot, each one on or off by itself. A member turns on "questions" and "approvals", and when an agent asks something, ostra DMs them one line and a link. They answer it in the panel; the message they got is edited to say who answered it.

In more words. Organization › Slack is one page, shaped like Organization › Email. It shows the app's bot scopes, the redirect URL the admin must give Slack, and, when settings set them, the app's client ID and secret as read-only. The admin creates a Slack app from the manifest ostra shows, pastes its client ID and client secret, and presses **Add to Slack**; Slack's consent page comes back with a code, ostra exchanges it for a bot token, reads back the workspace, the bot user and the granted scopes, and stores the token. The page then shows the workspace, the bot, the scopes, the token's renewal (when token rotation is on) and a **Send me a test message** button. Disconnect deletes every secret the installation held and stops every DM; the page says Slack is off and everything else works.

Each member's side is the existing grid with a Slack column. A member whose ostra address matches a workspace user turns moments on and sees "You're `@sam` in Acme's Slack" beside the column; one the workspace doesn't know sees "No Slack account for sam@acme.test" and a line saying to ask their Slack admin to add that address. Nothing is posted to a shared channel: every message is a DM, so a project's moments never become visible to a member who can't open that project.

### What milestones 1 to 11 leave that this starts from

Read from `main` on 2026-11-23 (`9f1f76bb`):

- **The notification kind is one adapter with three channels.** `NotificationAdapter` (`packages/adapter-sdk/src/notification/base.ts`) has `health()`, `send(notification)` and an optional `update(notification, providerMessageId)`; `NotificationCapabilities` (`capabilities.ts`) has `channels` and `edits`. The base's `SendResult` carries one `providerMessageId` and the recipients it refused, and the contract suite (`testing/notification-suite.ts`) already tests send-once-per-key, a refused recipient not failing the others, a rate limit, and editing where `edits` is true.
- **The channels are `panel`, `tracker` and `email`.** `packages/domain/src/notifications/choices.ts` has `notificationChannels = ["panel", "tracker", "email"]`, the defaults (`EMAIL_BY_DEFAULT`), `channelsFor`, `deliveryKey` (`notify:<item>:<change>:<member>:<channel>`) and `trackerDelivery`'s coalescing. Core's `notify.deliver` switches over the channel (`apps/core/src/notifications/deliver.ts`); fan-out writes one delivery per member and channel in one transaction (`packages/domain/src/use-cases/notifications.ts`) and, on an answer, writes an edit delivery for each sent **tracker** comment (`closeNotificationsInTx`).
- **The member's choices are per moment and channel.** `NotificationPreference` (`packages/db/prisma/schema.prisma`) is unique on `(memberId, kind, channel)`; the panel reads and saves it through `notifications.preferences.get`/`.save` (`packages/api/src/routers/notifications.ts`) into the grid at `apps/web/src/components/account/notification-settings.tsx`, whose columns are fixed at three.
- **The channel enum is `NotificationChannel` (`panel`, `tracker`, `email`).** It is a Postgres enum, and `DbEnum`/`src/enums.ts` and every exhaustive switch read it. `NotificationDelivery.adapter` already stores the adapter's name (`resend`, `smtp`, `panel`, `tracker`).
- **Email is the model for a per-install provider whose secrets are references.** `EmailSettings` holds `provider`, the from fields and secret **references** plus the namespace (`secretsOrganizationId`); `saveEmailSettings` (`packages/domain/src/use-cases/notification-settings.ts`) writes the value to the secret store and keeps only `secretRefSchema`; `apps/core/src/notifications/email.ts` builds an adapter per delivery from the row and never logs a value; the page (`components/organization/email-view.tsx`) is admin-only and shows "set"/"not set". This spec copies that shape for Slack.
- **The panel's page and the notifications grid** have approved targets: `context/brand/app-targets/m3/email-settings.md` and `notification-settings.md`. The Slack page and the fourth column follow them exactly; no new picture is drawn (section 10).
- **The seam tests hold each new record to isolation.** `packages/api/src/isolation/every-record.test.ts` is generated from the schema; a new table joins it. Milestone 4's isolation rule is "another organization's row is never found", and every domain and API test repeats it.
- **The fake-vendor pattern is established:** an HTTP fake in `packages/adapter-sdk/src/testing/` (`fake-linear/`, `fake-jira/`, `fake-email.ts`) with a base URL passed by a setting (`OSTRA_LINEAR_API_URL`, `OSTRA_JIRA_API_URL`, `OSTRA_RESEND_API_URL`). Slack's fake follows it at `OSTRA_SLACK_API_URL`.

### What is in, and what is not

**In:**
- one Slack app per organization installation, created by an organization admin from ostra's manifest, installed through Slack's OAuth v2 flow, with a bot token (`chat:write`, `users:read.email`);
- an installation row whose secrets are references: the client secret, the bot token and, when token rotation is on, the refresh token; the workspace, the bot user, the scopes and the token's date; disconnect deletes them all;
- token renewal: an expiring token is refreshed before it expires, and a `token_expired` answer refreshes once and retries;
- the fourth channel `slack`, a `SlackNotificationAdapter` package, and a fake Slack Web API the contract suite runs against;
- each member's Slack column, off by default, with their matched Slack account shown beside it and a "No Slack account" state;
- DMs for the needs-you and team moments, the budget notices, the runner notices and the preview notices, with the same words the panel and mail carry and the same "what a message may carry" rule (ADR 0050);
- the DM edited when the moment is answered or dismissed;
- retries on Slack's `Retry-After`, and a failing Slack delivery never holding back the other channels;
- Organization › Slack (install, states, test message, disconnect), the consent callback, the panel's row and message file copy;
- the docs: a Slack page and the configuration reference's lines.

**Not in** (and when it comes):
- **Incoming webhooks.** Rejected: one URL posts to one channel chosen at install, the channel can't be overridden, no message ID comes back, and messages can't be deleted or edited (ADR 0074, "Sending messages using incoming webhooks").
- **Shared-channel notifications.** Rejected for F-057: a channel shows a moment to everyone in it, and ADR 0050's audiences and project access are per member. A later "post to a channel" would be a separate channel with its own audience rule, not a Slack option.
- **Socket Mode, the Events API, interactivity, slash commands and answering from Slack.** Nothing comes back from Slack; the DM's link opens the panel, and every answer is made signed in (ADR 0050's no-bearer-link rule).
- **Slack as a tracker or a code host.** It is a notification channel only.
- **A distributable Slack app for every install.** Each install makes its own app; a public app would put its client secret in the distributor's hands, which a self-hosted product doesn't do (ADR 0074).
- **Sign in with Slack** to link a member's account. v1 of this feature matches by email; explicit linking is the fallback if email matching proves unreliable (section 9, an open question).
- **Several Slack workspaces per organization.** One installation per organization, as mail is one per install. Several would be a second `SlackInstallation`-like table, as trackers were (ADR 0071).
- **Slack for account mails** (invitations, verification, resets). They go by email: the person may have no account, and the link is a bearer credential (ADR 0053, 0050).
- **Slack as a dependency.** None: the client is hand-written on `fetch` with Zod schemas (section 9).

---

## 2. The decision, in one page

The whole of it is ADR 0074; this is the part a builder needs.

- **Install: a Slack app, installed by OAuth v2.** An organization admin creates the app in Slack from the manifest ostra shows (or uses an app they already made), enters its client ID and client secret once, and presses **Add to Slack**. ostra redirects to `https://slack.com/oauth/v2/authorize?client_id=…&scope=chat:write,users:read.email&redirect_uri=…`, and Slack redirects back to `<OSTRA_PUBLIC_URL>/api/slack/callback` with `code` and `state`. ostra exchanges the code at `oauth.v2.access` and reads the bot token, `bot_user_id`, `team.id`, `team.name` and `scope` from the answer. The redirect URL must be HTTPS, which Slack's OAuth guide states: an install served over plain HTTP can't complete it, and its page says so (section 4.8).
- **Why not an incoming webhook.** An incoming webhook is one URL for one channel, chosen by whoever adds it; the channel can't be overridden, the response carries no message timestamp, and a posted message can't be deleted (the webhook guide says so). It can't DM a member, so it can't be a per-member channel at all. Recorded in ADR 0074.
- **Destination: a DM.** `chat.postMessage` with a **user ID** as `channel` opens the 1:1 conversation if it isn't open; the method's reference says so and lists `chat:write`. The response's `channel` is the DM's ID (`D…`), which `chat.update` needs for a DM (its reference says a DM's value must be the `D`-ID, not the user ID).
- **Identity: the workspace user whose email is the member's ostra address.** `users.lookupByEmail` needs `users:read.email` and is Tier 3 (50+ per minute); the matched ID is cached per member and organization in `SlackIdentity`, so a moment costs no lookup once matched. A member with no match is `refused` for this channel and their delivery is skipped `no-slack-account`; the other members' messages still go. (Slack's page notes that legacy custom bot users can't call it; ostra's bot user is the app's own OAuth bot user, not a custom integration.)
- **Secrets: only references.** The installation row holds `clientSecretSecretRef`, `botTokenSecretRef`, `refreshTokenSecretRef`; the values live in the secret store in the organization's namespace, purposes `slack-client-secret`, `slack-bot-token`, `slack-refresh-token`. No page, log line, error, audit entry, adapter result or agent box ever carries a value.
- **Rotation: if the app has it on, refresh.** Without rotation a Slack access token never expires; with it, it expires every 12 hours, and a refresh token is single-use and must be replaced by the new one from each response ("Using token rotation"). ostra refreshes within 10 minutes *(working value)* of `tokenExpiresAt` and on a `token_expired` answer, writing the new access and refresh tokens in one transaction. A 401 that survives the refresh is a failure in words, and the page says to reinstall.
- **Choices: off by default, per moment.** Slack is a second private channel; a member opts into each moment. `defaultChoice(kind, "slack")` is `false` for every kind, and the panel's column stays always on. The choice only applies while an installation is active: no installation writes no Slack delivery, and turning Slack on doesn't deliver older moments.
- **Dedupe and edits.** Fan-out writes one delivery per member and moment with key `notify:<item>:<change>:<member>:slack`, in the same transaction as the others (ADR 0011); the adapter sends each key once. An answered or dismissed moment writes an edit delivery for each sent Slack message, and the adapter's `update` edits it in place, `edits: true`. `providerMessageId` is `slack:<D-channel>:<ts>`, the two fields `chat.update` needs plus the channel's name.
- **Rate limits.** Slack's Web API answers `429` with `Retry-After`; `chat.postMessage` is a "special" tier of about one message per second per channel with a workspace-wide limit, and `chat.update` and `users.lookupByEmail` are Tier 3 (50+ per minute). The adapter maps a 429 to `rate-limited` with `retryAfterMs`, and the delivery queue retries it (ADR 0050's per-delivery retry).
- **No text a message may not carry.** The DM carries the moment's heading, the organization's and project's names, the task's title and key, one line and a link — the fields ADR 0050 allows a mail. Never ticket text, agent output, a plan's text, a diff, a check's output or a comment. The adapter sets `mrkdwn: false`, `unfurl_links: false` and `unfurl_media: false`, so a task title with `*` or `<>` can't format or link anything.

---

## 3. The end-to-end demo

Ticket 10 runs it, in two runs, and records the result under its `## Comments` and in `demo.md` next to this spec. This is a post-v1 feature, so it doesn't wait for the launch gate; its demo runs when it is built.

**The scripted run** (`pnpm e2e:slack`, `e2e/post-v1-slack/`) runs every step it can without a person, on the `host` executor, with the fake Slack Web API (`02`) at `OSTRA_SLACK_API_URL` and `OSTRA_PUBLIC_URL` pointed at the dev server:

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `pnpm dev`, milestone 1 to 11's helpers: a model provider, the test App on `test1`, a project `test1`, a personal runner on `host`. The panel signs in as `demo@demo.com` / `demo`. Sam joins by invitation with the address the fake Slack knows.

1. **Slack is off.** Account › Notifications shows the Slack column, disabled, and the note "Slack isn't set up" with the admin's link. Everything else works.
2. **Install.** Organization › Slack shows the manifest, the two scopes and the redirect URL. Demo saves the fake app's client ID and secret, presses **Add to Slack**: the fake authorize page comes back with a code and state, ostra reads back `Acme Test`, the bot `ostra` and the two scopes, and the page shows **Connected** and the token's date. A wrong state, a wrong secret and a refused code each say what happened, in words, and store nothing.
3. **The test message.** **Send me a test message** puts one DM in the fake's store; its text is the test's line and a link, and no token, address or app secret is in the panel, the logs or the response.
4. **Choices.** Demo turns on `question` and `approval` on their own row; Sam turns on `question`. Their rows show `@demo` and `@sam`; a third member the fake doesn't know shows "No Slack account", and their box is still usable.
5. **A moment.** A prompt task reaches a question. Demo gets one DM: the heading, project, task title and a link, and the fake's store has exactly one message for the moment. Sam, who drives the task, gets one too; the member with no account gets none, and their delivery row is `skipped` with "no Slack account".
6. **The answer edits it.** Demo answers in the panel. The fake's message changes in place to say who answered; no new message appears. The stored ID is the DM's `D…` and the message's `ts`.
7. **A burst and a rate limit.** Three moments in a minute produce three DMs, and a fake 429 on the second leaves it `pending` with the `Retry-After`, then sends it once; the same moment's panel delivery is recorded independently and is unaffected.
8. **Disconnect.** Demo presses Disconnect. The fake's store gets no more messages; the secret store has no `slack-*` value left; the row is `revoked`, the page says Slack is off, and the notifications column is disabled with the others still saved.
9. **Isolation.** In the scripted run's second world (another organization), Slack is off and the first organization's installation, identities and Slack preferences are invisible.

**The manual run, once, in a real browser on the maintainer's workspace:** the same steps 2 to 8 against `ostra-test.slack.com`, with the real app ticket 09 names, a real DM to the maintainer and to a second member, a real answer's edit, and a real disconnect. Ticket 09 owns the workspace, the app and the secrets file.

---

## 4. Pieces by package

### 4.1 `packages/db` (ticket 01)

One migration after the last one on `main`, additive only:

- **`NotificationChannel` gains `slack`.** Every value the old release writes stays valid; the new release alone writes `slack`. `src/enums.ts`'s mappings and every exhaustive switch gain it in the same commit (`adapterNameOf`, `channelsFor`'s filter, the panel's column label, the delivery worker's switch, `SKIP_WORDS`).
- **`SlackInstallation`** (new, `@@map("slack_installation")`): `id`, `organizationId` **unique**, `state` (`pending`, `active`, `failed`, `revoked`), `clientId` (not a secret), `clientSecretSecretRef`, `botTokenSecretRef`, `refreshTokenSecretRef` (null when rotation is off), `teamId`, `teamName`, `botUserId`, `appId`, `scopes` (`String[]`), `tokenExpiresAt`, `lastCheckedAt`, `lastError` (words and IDs only), `oauthStateHash`, `oauthStateExpiresAt`, `installedByMemberId`, `createdAt`, `updatedAt`, `revokedAt`. Every secret column holds a `SecretRef`, never a value; each has a `///` doc line saying so.
- **`SlackIdentity`** (new, `@@map("slack_identity")`): `id`, `organizationId`, `memberId`, `slackUserId`, `slackTeamId`, `matchedEmail`, `checkedAt`, `createdAt`, `updatedAt`; **unique `(organizationId, memberId)`**, and the member relation cascades. A row means "matched"; no row means "not matched" (no negative rows, so a later change in Slack is seen at the next moment).
- **No change to `NotificationPreference`.** Its `channel` column is the enum, so `slack` rows need nothing new.
- **Data:** none. An existing install has no Slack rows and every member's Slack column reads off by default.

**Indexes:** `SlackInstallation.organizationId` unique is the one-Slack-per-organization rule; `SlackIdentity`'s unique holds one row per member; `@@index([organizationId, slackUserId])` on identities for an admin's list if it ever needs one.

### 4.2 `packages/adapter-sdk` (ticket 02)

- **`testing/fake-slack/`:** an HTTP fake in the house style of `fake-jira/` and `fake-email.ts`, on loopback, with no dependency:
  - `POST /api/auth.test`: `{ ok, team, team_id, user, user_id, bot_id }` for a good token, `{ ok: false, error: "invalid_auth" }` otherwise, and `token_expired` when the fake's token was expired;
  - `GET /api/users.lookupByEmail`: the user object for a known address, `users_not_found` for an unknown one, `account_inactive` for a deactivated one, `missing_scope` when `users:read.email` wasn't granted, a 429 on demand with `Retry-After`, and the "custom bot users cannot use this method" refusal as a control;
  - `POST /api/chat.postMessage`: accepts a user ID or a `D`-ID as `channel`; a user ID opens (or reuses) a DM and the response's `channel` is its `D`-ID; a message's ID is `<channel>:<ts>`; it records the text, `mrkdwn`, `unfurl_links`, `unfurl_media` and the token's digest; a 429 on demand with `Retry-After`; `channel_not_found` for an unknown user; `missing_scope` without `chat:write`; `msg_too_long` beyond Slack's 40,000-character cut-off;
  - `POST /api/chat.update`: updates only a message the same bot posted; `cant_update_message` for another's; `message_not_found` for a gone one; a `D`-ID is required for a DM (a `U`-ID answers `channel_not_found`);
  - `POST /api/oauth.v2.access`: an authorization-code exchange answering a bot token, `bot_user_id`, `team`, `app_id`, `scope` and, with rotation, `expires_in` and `refresh_token`; a `refresh_token` grant answering a new access token **and a new refresh token**, refusing a reused one; `invalid_code`, `bad_client_secret` and `bad_redirect_uri` controls;
  - `GET /oauth/v2/authorize`: a page that redirects to the fake's configured redirect URL with a code and the state, for the browser spec.
- **`testing/notification-suite.ts`'s docs** gain the Slack fixture example; the suite itself is generic and needs no case for Slack (send, refused, rate limit and edit already cover it). If a case is truly Slack-specific — nothing in the base is — it goes in the suite, not the adapter's own file.
- **No export** is added to the SDK's `notification/base.ts` except the two skip reasons aren't here (they are domain's). The `slack` channel value is a string, so `NotificationCapabilities.channels` needs no type change.

### 4.3 `packages/adapters/adapter-slack` (ticket 03)

A new Apache-2.0 package beside `adapter-email-resend`: `SlackNotificationAdapter extends NotificationAdapter`, one level deep (ADR 0025). It imports `@ostra/adapter-sdk`, `@ostra/protocol` and `zod` only; no Slack SDK (section 9).

- **Options:** `{ apiUrl: string; token: string; timeoutMs?: number }`. `apiUrl` defaults to `https://slack.com/api`; tests and the scripted run point it at the fake. The token is the bot token, read by core from the secret store; never logged, never in an error.
- **`send(notification)`:** refuses an `account` mail as `unsupported` (`refuseAccountMail("slack")`); for each recipient, resolves the Slack user ID the notification carries (section 4.4's `NotificationRecipient.slackUserId`, a new field) and posts:
  - `channel`: the user ID (the DM opens on it), `text`: the notification's `body`, which core set from `renderSlackDm` (heading, project, task title and key, one line, URL), `mrkdwn: false`, `unfurl_links: false`, `unfurl_media: false`;
  - the answer's `channel` and `ts` become `providerMessageId` as `slack:<D-channel>:<ts>` (one string, because `SendResult` has one); `refused` carries each member whose user ID is null or whose post was rejected with `channel_not_found`/`users_not_found`, with words, without failing the others;
  - `ok: false` maps by Slack's `error`: `invalid_auth`/`token_revoked`/`account_inactive`/`missing_scope`/`not_authed` → `unauthorized`/`forbidden`; `ratelimited` → `rate-limited` with `Retry-After`; `internal_error`/`fatal_error`/`service_unavailable`/`request_timeout` → `unavailable`; `channel_not_found` → `not-found`; anything else → `invalid-response`.
- **`update(notification, providerMessageId)`:** parses `slack:<D>:<ts>` with a strict schema and calls `chat.update` with the same text and the new state (answered/dismissed); `cant_update_message`/`message_not_found` → `not-found`, so core skips it as "nothing to edit"; a bad ID → `invalid-input`. The adapter's capability is `{ channels: ["slack"], edits: true }`.
- **`health()`:** `auth.test` with the token: `ok` or `down` with Slack's error code in words. No token in the answer.
- **Idempotency:** the plumbing's idempotency keyed by `notification.idempotencyKey`, as the email adapters do: a second send of a key answers the first's `providerMessageId` and posts nothing. The delivery row's `sent` state is the durable guard; the in-process map is the contract suite's.
- **Rate budget:** named by a digest of the token (as Linear's is), honouring `Retry-After`. `users.lookupByEmail` is not called by the adapter (it has the ID); it is called by core when matching (section 4.5).
- **The client's schemas** tolerate unknown fields (Slack adds them); every response is checked for `ok` and narrowed.

### 4.4 `packages/domain` (ticket 04)

- **The channel:** `notificationChannels` becomes `["panel", "tracker", "email", "slack"]`; `defaultChoice(kind, "slack")` is `false` for every kind; `choiceLocked` stays panel-only; `channelsFor` takes `slackOn: boolean` (an active installation) and includes `slack` only when the member wants it. **No identity check here:** fan-out can't know whether Slack knows an address, so the delivery is written and skipped at send (section 4.5), keeping fan-out pure and one transaction.
- **`adapterNameOf("slack", provider)`** is `"slack"`. `fanOutNotification` reads the organization's installation in its transaction (one query, `state` only) and passes `slackOn: state === "active"` into `channelsFor`; a fresh install with no row writes no Slack delivery.
- **Skip reasons:** `DeliverySkipReason` gains `"slack-off"` ("Slack is off.") and `"no-slack-account"` ("The member has no Slack account."); `SKIP_WORDS` carries both; the panel shows them under a failed row as the others.
- **The recipient's ID:** `NotificationRecipient` (SDK) gains `slackUserId: string | null`, set by core's Slack branch. It is a user ID, not a secret.
- **The DM's words:** a pure `renderSlackDm(input)` beside `email.ts`'s renderers, tested on the allowed fields: heading, organization, project, task title and key, one line, URL; and on the forbidden ones (ticket text, agent output, a plan's text, a diff, check output, a comment, a token, an address). Plain text only, no Slack markup.
- **Edits on an answer:** `closeNotificationsInTx` writes an edit delivery for each sent **editable** channel's message (`tracker` and `slack`), not only the tracker's. `editableChannels = ["tracker", "slack"] as const` is the one list, with a test that every `NotificationAdapter` declaring `edits` is in it.
- **The installation's use cases** (`use-cases/slack-installation.ts`), each admin-only unless said, each audited:
  - `startSlackInstall({ clientId, clientSecret })` → refuses `already-installed` while active; stores the client secret in the secret store (`slack-client-secret`), writes a `pending` row with a random 32-byte `oauthStateHash` (SHA-256) and a 10-minute expiry, and answers the authorize URL and the state (the state is the row's ID plus the nonce; the hash alone is stored);
  - `completeSlackInstall({ code, state, redirectUri, kit })` → finds the pending row by the state's hash, not expired; exchanges the code; reads back with `auth.test` that the token is the app's bot and its team is the row's; stores the bot token, the refresh token and the expiry, the team, the bot user, the app ID and the scopes; `active`; audit `slack.installed`;
  - `refreshSlackToken({ installationId, kit })` → for a row with a refresh token nearing its date: exchanges it, writes the new access token **and** the new refresh token (single-use), and updates the date; audit `slack.token-refreshed` (IDs only). Called by core before a send and on `token_expired`; a refusal marks the row `failed` with words;
  - `recheckSlackInstall` (admin), `renameSlackTeam` is not a thing (the workspace names itself), `disconnectSlack` → deletes every secret of the installation, sets `revoked`, clears `team` fields? No: keeps the workspace's name for history, clears the secret refs and the state; audit `slack.disconnected`;
  - `matchSlackIdentity({ memberId, email, kit })` → returns the cached `SlackIdentity` while its `matchedEmail` is the member's address; else `users.lookupByEmail`, writing or replacing the row on a match, and deleting it on `users_not_found`/`account_inactive`. A Slack `is_bot`/`deleted` user is no match;
  - `saveSlackSettings` (client ID and secret from the panel; secrets by reference, as `saveEmailSettings`), refused while `OSTRA_SLACK_*` sets them.
- **The state's lifecycle** is a discriminated union with exhaustive tests: `pending` (no token), `active` (token, team), `failed` (token refused: the row stays readable, DMs stop), `revoked` (secrets gone). `slackStateOf(row)` is the one derivation the page, the delivery and the tests read.
- **Audit actions:** `slack.installed`, `slack.settings-saved`, `slack.token-refreshed`, `slack.failed`, `slack.disconnected`.
- **The connect port** `SlackConnectKit` (`exchangeCode`, `refresh`, `check`, `lookupByEmail`) with the domain's own result unions, injected like `JiraConnectKit`; a fake kit in `domain/testing/` with each outcome.

### 4.5 `apps/core` (ticket 05)

- **`notifications/slack.ts`:** `createSlackChannel(deps)`, shaped like `createEmailChannel`:
  - resolves the organization's active installation; none → `skipped: { why: "slack-off" }`;
  - refreshes an expiring token through `refreshSlackToken` before using it; `token_expired` on a send triggers one refresh and one retry, and a second refusal is `failed` in words;
  - for each delivery, matches the member's identity (`matchSlackIdentity`) from their account address; no match → `skipped: { why: "no-slack-account" }`; a match → a `MomentNotification` with `slackUserId` and the words `renderSlackDm` gives, sent through the adapter built from the token;
  - budget, runner and preview notices go through the same loaders `email.ts` uses (`loadBudgetNoticeView`, `loadRunnerNoticeView`, `loadPreviewShareNotice`), so their Slack words are the panel's, and a notice gone or a name taken off is `skipped: closed`;
  - a send's `refused` entry for the member is a skipped `no-slack-account`, not a failure; any other error is `failed` with `retryable` from the same table.
- **`notify.deliver`** gains `case "slack": result = { outcome: await deps.slack.deliver(row), siblings: [] }`; `NotifyDeps` gains `slack: SlackChannel`; `core.ts` builds it with `realSlackFactory(settings.slackApiUrl)` and the connect kit, and closes nothing (the adapter is stateless).
- **The edit delivery** (`change !== "created"`) is handled by the same branch: `SlackChannel.deliver` sends the moment's closing text to the stored `providerMessageId` through `update`, and a `not-found` is `skipped: nothing-to-edit`.
- **Fan-out** needs nothing beyond the domain's changes; core's `notifyFanoutHandler` stays as it is.
- **The token's checks:** a 5-minute job (`slack.token-check`, no new queue) refreshes any installation within 10 minutes of its date, and marks a refused one `failed` with words and an audit entry. Without rotation the job does nothing.
- **No log line** carries a token, a code, a state's nonce, an address or a DM's text; `slack.logged` tests assert it from the fake's records and the logger's records.

### 4.6 `packages/api` (ticket 06)

- **`routers/slack.ts`:**
  - `status` (member): `state`, the workspace's and bot's names when connected, the scopes and the token's date (never a value), `clientId` (public), whether the client secret is set, whether settings lock the form, the install URL's manifest text, the redirect URL, the member's own identity (`@name`, matched address, or "none"), and the last check's words;
  - `settings.save` (organization admin; instance admin when settings lock nothing? The install's Slack is the organization's, so an **organization admin** saves it, as the page says; `OSTRA_SLACK_*` locks it);
  - `install.start` (organization admin) and `install.complete` (the callback's caller; the state proves the session);
  - `disconnect` (organization admin), `check` (organization admin), `sendTest` (organization admin, to their own matched identity; `no-slack-account` in words when unmatched);
  - `identity.get` (member), `identity.refresh` (member; one lookup, rate-limited by the adapter's budget).
- **`services/slack-connect.ts`:** implements `SlackConnectKit` on `adapter-slack`'s exported calls, as `services/jira-connect.ts` implements Jira's; wired in `runtime.ts`.
- **`apps/web/src/app/api/slack/callback/route.ts`:** reads `code`, `state` or `error`, calls `slack.install.complete`, and redirects to `/organization/slack` with `connected=1` or the refusal in words; a code, a state and a token are never in the message. A refusal from Slack (`access_denied`) is in words.
- **`notifications.preferences.get/.save`** gain the `slack` channel by the domain's list (no hand-written three); `get` also answers `slackOn` and the member's identity, and the save's max grows by the list's length.
- **Isolation:** every procedure scopes by the context's organization; a Slack row of another organization is `not-found`, as every other row.

### 4.7 `apps/web` (ticket 07)

- **`/organization/slack`** (`app/(panel)/organization/slack/page.tsx`, `components/organization/slack-view.tsx`, `slack-settings.tsx`, `slack-words.ts`), a `slack` row in `places.ts`'s `OrganizationRow` after `email`, gated `admin`, the icon `slack` (a rail icon from `shell-icons.tsx`) or `message-square`; crumbs Organization › Slack.
  - **Not set up:** the manifest to copy, the two scopes, the redirect URL, the client ID and secret fields, **Save**, **Add to Slack**. The scopes and the redirect URL are shown as text with a copy button.
  - **Pending:** "Waiting for Slack" with a **Continue in Slack** link and a **Start again**.
  - **Connected:** the workspace, the bot, the scopes, the token's date and its renewal state, **Send me a test message**, **Check again**, **Disconnect**, and the member's own identity line.
  - **Failed:** Slack's refusal in words, **Reconnect**, **Disconnect**.
  - **Locked:** when `OSTRA_SLACK_*` sets the app, the fields are read-only and the settings' names are shown, as Organization › Email does.
- **The notifications page** (`components/account/notification-settings*.tsx`): a fourth 88px column "Slack", disabled with the note when Slack is off, the panel's box still locked, the member's identity line above the grid when connected, and a link to Organization › Slack for admins. The grid's width grows by one column; the phone layout gains one labelled cell per row, as the existing three do.
- **Copy:** `messages/en.json` keys under `slack.*`, `notificationSettings.slack*`, `shell.slack`.
- **Design:** follows `context/brand/app-targets/m3/email-settings.md` and `notification-settings.md`; ticket 07 compares at 1440 and 390 px in both themes and records the screenshots under its `## Comments`.

### 4.8 Settings

| Setting | Default | What it does |
|---|---|---|
| `OSTRA_SLACK_API_URL` | `https://slack.com/api` | Slack's Web API, and the origin the OAuth exchange and the fake use. Set it only to the fake Slack in tests |
| `OSTRA_SLACK_CLIENT_ID` | unset | The app's client ID. Set with the secret, it locks the panel's Slack form to it |
| `OSTRA_SLACK_CLIENT_SECRET` | unset | The app's client secret. Never logged. Set with the client ID, it locks the panel's Slack form |
| `OSTRA_SLACK_TOKEN_REFRESH_MINUTES` | `10` | How early an expiring token is refreshed *(working value)*; without token rotation it does nothing |

The redirect URL is derived from `OSTRA_PUBLIC_URL` (`<public>/api/slack/callback`); no setting names it. A fresh install with only the required settings has Slack off, and everything else works.

**The HTTPS limit is real and is the page's job to say:** Slack's OAuth guide requires the redirect URL to use HTTPS. An install served at `http://localhost` can't complete a real install; the page says "Slack needs an https public address", and the scripted run uses the fake. The maintainer's own install has HTTPS (their reverse proxy).

### 4.9 Docs (`apps/docs`, ticket 08)

A **Slack** page under the panel's integrations: what the channel does, the manifest, the two scopes, the redirect URL, installing, the member's column, the DM's contents (the same list ADR 0050 gives a mail), the token's renewal, disconnect, and the HTTPS requirement. The configuration reference gains the four settings above. Organization › Email's page gains a "Slack is separate" line and a link.

---

## 5. Parity

### Adapter parity

| What the feature asks | `adapter-slack` | The fakes |
|---|---|---|
| `send` once per `idempotencyKey` | yes, the plumbing and the delivery row | the fake’s message store; the contract suite sends the same key twice |
| A refused recipient without failing the others | `refused` for an unknown/absent Slack user, words only | the fake refuses named addresses and users |
| A rate limit as `rate-limited` with `Retry-After` | yes, from a 429 | the fake's on-demand 429 |
| Editing where `edits` is true | `chat.update` on its own message | the fake's message store |
| `health()` | `auth.test` | the fake's `invalid_auth` |
| No account mail | `unsupported` | the suite's account case |

The parity test (`packages/adapter-sdk/src/testing/parity.test.ts`) gains a row for the new adapter against its fake. No tracker, code-host, agent or executor interface changes: the feature only delivers messages.

### Runner parity

Nothing here reaches a runner. No token, no DM's text and no identity is ever in the runner protocol, a box or an executor; the executor suite is untouched. The DM's link opens the panel, not a box.

---

## 6. Packages, licenses and owners

| Package | License | New | Built by |
|---|---|---|---|
| `packages/db` | Sustainable Use | one migration: the `slack` channel, `SlackInstallation`, `SlackIdentity` | core (01) |
| `packages/adapter-sdk` | Apache-2.0 | `testing/fake-slack/`; the suite's Slack docs | adapters (02) |
| `packages/adapters/adapter-slack` (new) | Apache-2.0 | the adapter and its client, on `fetch` and `zod` only | adapters (03) |
| `packages/domain` | Sustainable Use | the channel, the choices, the skip reasons, the DM's words, the installation's use cases and port | core (04) |
| `apps/core` | Sustainable Use | the Slack channel, the delivery switch, the token's check | core (05) |
| `packages/api` | Sustainable Use | `slack.*`, the preferences' fourth channel, the connect kit | api (06) |
| `apps/web` | Sustainable Use | Organization › Slack, the callback route, the fourth column | web (07) |
| `apps/docs` | Apache-2.0 | the Slack page, the settings' lines | core (08) |
| `e2e/post-v1-slack` (new) | Sustainable Use | the scripted demo | core (10) |

The license line holds (ADR 0045, ADR 0048): `adapter-slack` imports only `@ostra/adapter-sdk`, `@ostra/protocol` and `zod`; no Apache-2.0 package depends on a Sustainable Use one. `SlackConnectKit` is implemented in `packages/api/src/services/slack-connect.ts` on the adapter's exported calls and wired in the API's composition root; core builds the adapter from the installation's token. `pnpm check:licenses` runs on every commit.

---

## 7. The builders and their tickets

Five builders: **core**, **adapters**, **api**, **web** and the **maintainer**. 01 and 02 start together; 03 follows 02; 04 needs 01; 05 needs 03 and 04; 06 needs 03 and 04; 07 needs 06.

| # | Ticket | Builder | Blocked by | Visual |
|---|---|---|---|---|
| 01 | DB: the Slack migration | core | none | no |
| 02 | Adapter SDK: the fake Slack Web API | adapters | none | no |
| 03 | Slack adapter: the client, `send`, `update` and `health` | adapters | 02 | no |
| 04 | Domain: the installation, the identity and the member's choice | core | 01 | no |
| 05 | Core: the Slack channel and its deliveries | core | 03, 04 | no |
| 06 | API: Organization › Slack and the consent flow | api | 03, 04 | no |
| 07 | Web: Organization › Slack and the notifications column | web | 06 | yes |
| 08 | Docs: Slack | core | 06 | no |
| 09 | The maintainer's steps outside the code | maintainer | none for the app; 10 for the review | no |
| 10 | The end-to-end demo and the ledger | core (lead) | 01 to 08, 09's workspace | no |

**Who starts when.** core takes 01 and 04 as they land; adapters take 02 then 03; api builds 06 on 03's calls and 04's port; web builds 07 against the existing targets once 06 answers; docs follows 06. The maintainer can make the workspace and app (09) while 03 to 07 are built, so 10's manual run has them.

---

## 8. Test seams and checks

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads a Slack row checks that another organization's rows stay invisible; `every-record.test.ts` gains the two tables.
- **Slack:** one HTTP fake (`testing/fake-slack/`) for the adapter's tests, the domain's and core's Slack tests through a fake kit where the API is enough, the API's consent tests, the browser spec and the demo. Two modes: a workspace with two known addresses and a bot, and one with neither. It signs no request (Slack's Web API authenticates by token, not by a webhook secret).
- **The connect kit:** a fake `SlackConnectKit` in `domain/testing/` with each exchange's outcomes (a good code, a reused refresh token, a refused token, an unknown address), for the use cases' tests.
- **Time:** the state's 10 minutes, the token's 10-minute refresh window and the 5-minute job read the `Clock` port.
- **Text that is data:** every test of a DM's words holds a task title with `*`, `<>`, `@channel`, a URL, a newline and a 4 KiB string, and asserts the fake received them literally (`mrkdwn: false`), no log line carries them, and no shell command is built from them.
- **Checks and commits,** as milestones 1 to 11 and the lead's rules: `pnpm typecheck`, `pnpm lint` and `pnpm test` for the touched packages (and their direct consumers when a shared type changes) once before each push, with `--cache-dir=C:/Users/santi/ow/.turbo-cache`; `pnpm check:licenses` passes; the whole-repo checks for 01, 03, 04 and 06 (schema and credentials); a gitmoji message of at most 50 characters, no AI attribution; stage only the ticket's paths; work in a worktree under `C:/Users/santi/ow/<name>`; no secret in the commit.
- **Proof:** each condition of F-057's "done when" has a test named with its key (`it("F-057/c1: ...")`) that exercises it through the real code path; CI runs them. A condition only a real workspace shows waits for ticket 10's manual run, and its row stays `building` until then.
- **Dependencies:** none (section 9).

### 8.1 How each condition gets proved

- **c1** (install): 01, 04, 06, 07 — the manifest, the state, the exchange, the read-back, the page's states.
- **c2** (secrets): 01, 03, 04, 05, 06, 07 — references only; no value in a page, a log, an audit, an error or an adapter result; disconnect deletes them.
- **c3** (choices): 01, 04, 05, 07 — off by default; the delivery only when on; the panel's column always on.
- **c4** (the words): 03, 04, 05 — the allowed fields, the forbidden ones, `mrkdwn: false`.
- **c5** (DM, email matching, unknown member): 03, 04, 05, 07 — the user ID opens a DM, the identity cache, the skip.
- **c6** (once, edits): 02, 03, 04, 05 — one message per key; an answer's edit; `nothing-to-edit`.
- **c7** (rate limits, isolation of channels): 03, 05 — a 429 with `Retry-After`; a failed Slack delivery not holding the others; a token expiry's refresh and retry.
- **c8** (the contract suite, off, isolation): 02, 03, 04, 06 — the suite green for `adapter-slack`; no installation, everything else works; another organization's rows invisible.
- **c9** (the live run): 10 and 09 — **only** the manual run on the maintainer's workspace shows it.

---

## 9. Dependencies and open questions

**No dependency is added.** Slack's Web API is a handful of JSON endpoints; a hand-written client on `fetch` with Zod schemas keeps the calls, the errors and the rate budget in ostra's shape, as `adapter-email-resend` and `adapter-jira` do. `@slack/web-api` (MIT) was considered and is not needed for four calls; its retry and OAuth helpers would be one more library to pin and approve. If real use shows the client is the wrong call, that is a later ADR.

**Open questions for the maintainer** (proposed for `context/open-questions.md`; none blocks, because each has a recorded default):
1. **A drawn target for Organization › Slack?** The page follows `app-targets/m3/email-settings.md` with the manifest and Slack's states; the maintainer may want a picture before it's built (ticket 07 says what it will look like either way).
2. **The public app.** Would the maintainer ever ship one Slack app for every install (public distribution, one client secret with the distributor), or does each install keep making its own app? ADR 0074 records "each install makes its own"; a public app is a hosted-service dependency this project avoids.
3. **Sign in with Slack for identity**, if email matching proves unreliable in real workspaces (addresses that differ, guests, hidden emails). ADR 0074 records email matching as v1 of this feature and the fallback.
4. **Shared-channel notifications** (a project's moments in one channel, for teams that prefer that): a different audience rule, not a Slack option.
5. **A bot-token paste** for installs that can't serve HTTPS, as a fallback to OAuth: the admin copies `xoxb-…` from Slack's app page; simpler, but no read-back of the scopes and no rotation (ADR 0074's considered options).

---

## 10. Screens and their targets

This is a post-v1 feature, so no milestone's design gate applies. The two screens follow the approved targets exactly:

| Target (in `app-targets/m3/`) | Screen | Ticket |
|---|---|---|
| `email-settings.md` | Organization › Slack: the same page frame, properties panel and foot; the provider block becomes the manifest, scopes, redirect URL, client ID and secret, and Slack's three states | 07 |
| `notification-settings.md` | The grid's fourth column, the identity line, the off note and the phone cells | 07 |

Ticket 07 compares each at 1440 and 390 px in both themes and records the screenshots under its `## Comments`. The maintainer looks at the build in ticket 09.
