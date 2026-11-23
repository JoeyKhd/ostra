# 04: Domain: the installation, the identity and the member's choice

Status: ready-for-agent
Builder: core
Features: F-057
Packages: `packages/domain` (`notifications/choices.ts`, `notifications/slack.ts`, `use-cases/notifications.ts`, `use-cases/slack-installation.ts` (new), `use-cases/m3-signatures.ts`, `use-cases/notification-settings.ts`, `audit/actions.ts`, `testing/`, `index.ts`), `packages/adapter-sdk` (`NotificationRecipient.slackUserId`)
Blocked by: 01
Spec: `../spec.md`, section 4.4; ADR 0050, ADR 0074

## What to build

- **The fourth channel:** `notificationChannels = ["panel", "tracker", "email", "slack"]`; `defaultChoice(kind, "slack")` false for every kind; `choiceLocked` unchanged; `channelsFor` gains `slackOn: boolean` and includes `slack` only when it is true and the member wants it. `adapterNameOf("slack", provider)` is `"slack"`. Every exhaustive switch over the channel compiles from this one list.
- **The recipient's Slack ID:** `NotificationRecipient` in `packages/adapter-sdk/src/notification/base.ts` gains `slackUserId: string | null`, documented as a user ID, not a secret. Every producer (`panelOutcome`, `trackerOutcome`, email) sets it `null`.
- **Fan-out:** `fanOutNotification` reads the organization's installation in its own transaction (`state` only) and passes `slackOn: state === "active"` into `channelsFor`; no row means no Slack delivery. The email-provider read and the installation read are two small queries in the same transaction.
- **Skip reasons:** `DeliverySkipReason` gains `slack-off` ("Slack is off.") and `no-slack-account` ("The member has no Slack account."); `SKIP_WORDS` and `skipWords` carry both.
- **The DM's words:** `renderSlackDm(input)` in `notifications/slack.ts` (pure): the heading, the organization's and project's names, the task's title and key when it has one, one line and a URL, plain text. A test holds an untrusted title with `*`, `<>`, `@channel`, a newline and 4 KiB and asserts no markup, no interpolation into a shell command, and none of the forbidden fields (ticket text, agent output, a plan's text, a diff, check output, a comment, an address, a token).
- **Edits on an answer:** `closeNotificationsInTx` writes an edit delivery for each sent message on an **editable channel**, `const editableChannels = ["tracker", "slack"] as const`, not only `tracker`; a test reads the list against every adapter that declares `edits`.
- **The installation's use cases** (`use-cases/slack-installation.ts`), each admin-only except where said, each audited:
  - `startSlackInstall({ clientId, clientSecret, publicUrl })`: refuses `already-installed` while `active`; saves the client secret (`slack-client-secret`) and the client ID; writes the row `pending` with a 32-byte nonce's SHA-256 and a 10-minute expiry; answers the state (the row's ID and the nonce) and the authorize URL (scopes `chat:write,users:read.email`).
  - `completeSlackInstall({ code, state, redirectUri, kit })`: finds the `pending` row by the state's hash, not expired; exchanges; `auth.test`s the token and refuses one whose bot user or workspace doesn't match; saves the bot token, the refresh token and the date, the workspace and bot names and IDs, the app ID and the scopes; `active`; audit `slack.installed`.
  - `refreshSlackToken({ installationId, kit, now })`: only with a refresh token nearing its date; saves the new access **and** refresh token (single-use) and the new date; audit `slack.token-refreshed`; a refusal marks `failed` with words and audits `slack.failed`.
  - `disconnectSlack({ installationId })`: deletes every secret of the row, clears the refs, sets `revoked` and `revokedAt`, keeps the workspace's name; audit `slack.disconnected`.
  - `matchSlackIdentity({ organizationId, memberId, email, kit })`: the cached row while `matchedEmail` is the address; else one lookup, writing/replacing on a match and deleting on `users_not_found`/`account_inactive`; a `deleted`/`is_bot` user is no match.
  - `saveSlackSettings({ clientId, clientSecret })`, refused while `OSTRA_SLACK_*` sets them.
  - `slackStateOf(row)` as a discriminated union (`pending`, `active`, `failed`, `revoked`) with exhaustive tests.
- **The port:** `SlackConnectKit` (`exchangeCode`, `refresh`, `check`, `lookupByEmail`) with the domain's result unions, injected like `JiraConnectKit`; a fake kit in `domain/testing/` with each outcome.
- **Audit actions:** `slack.installed`, `slack.settings-saved`, `slack.token-refreshed`, `slack.failed`, `slack.disconnected`.

## Done when

- [ ] Tests named for `F-057/c3`: the Slack column exists for every choosable moment, its default is off for each, the panel's is locked on, and `channelsFor` includes `slack` only with `slackOn` and the member's choice; no Slack delivery is written without them.
- [ ] Tests named for `F-057/c5`: a known address writes a `SlackIdentity`, a second call answers the cache with no lookup, a changed address re-matches, an unknown/deactivated address deletes it and answers no match; a `deleted`/`is_bot` user is no match.
- [ ] Tests named for `F-057/c4`: `renderSlackDm` carries the allowed fields only and the untrusted title literally.
- [ ] Tests named for `F-057/c6`: closing fan-out writes an edit delivery for a sent Slack message as it does for the tracker's, with key `notify:<item>:<answered|dismissed>:<member>:slack`.
- [ ] Tests named for `F-057/c1`: `startSlackInstall` writes a pending row and a state that only its nonce opens; `completeSlackInstall` refuses a wrong/expired state, a wrong client secret and a token whose bot or workspace doesn't match; a good exchange stores the team, bot, app ID and scopes as `active`; `already-installed` while active.
- [ ] Tests named for `F-057/c2`: every secret is stored through the secret store and only its reference on the row; `disconnectSlack` deletes all three and leaves no reference; the audit entries carry IDs only.
- [ ] Tests named for `F-057/c7`: `refreshSlackToken` replaces the access and refresh tokens together and only near the date; a refusal is `failed` in words; without a refresh token it does nothing.
- [ ] Tests named for `F-057/c8`: another organization's installation, identity and preferences are never found; the lifecycle's union is exhaustive (`satisfies never`).
- [ ] Typecheck, lint and tests for `packages/domain` and its direct consumers pass, with the whole-repo checks (credentials and the schema's meaning changed).
- [ ] Committed as `✨ match members and install Slack`.

## Comments
