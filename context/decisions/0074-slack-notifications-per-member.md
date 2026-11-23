# Slack notifications, per member, as DMs from an installed app

**Status:** proposed (2026-11-23, with the post-v1 spec `specs/post-v1-slack/`). Covers F-057, which is `later`; nothing is built until the maintainer starts it. Builds on ADR 0025 (everything is an adapter), ADR 0048 (the license split), ADR 0050 (notifications, audiences and what a message may carry), ADR 0053 (organizations and isolation) and ADR 0011 (nothing acted on before it's saved). Nothing here is settled by the maintainer yet; the spec's open questions (section 9) are the places to change it.

## Context

F-036 reaches a "needs you" moment's audience in the panel, on the task's ticket and by email; each member chooses per moment and channel (ADR 0050). F-057 says the same moments should also reach members in Slack, "as each member chooses". Slack is a fourth private channel, not a fourth tracker: it delivers a message and takes no answer (every answer is made signed in, on the panel's page).

Slack offers several ways to post, and they differ in a way that decides the feature:

- **An incoming webhook** is one URL for one channel, picked by whoever creates it. Its guide says the channel can't be overridden, the user, name and icon come from the app's own configuration, it returns no message `ts`, and a posted message can't be deleted. It can post to a channel only, never to a person's DM.
- **A Slack app with a bot token** calls the Web API. `chat.postMessage` with a member's **user ID** as `channel` opens the 1:1 DM if it isn't open, and its response carries the DM's channel ID and the message's `ts`. `chat.update` edits a message the bot posted, and needs the DM's `D…` ID, not the user ID, for a DM.
- **A bot token obtained by OAuth v2** (`oauth.v2.access`) comes with the workspace's ID and name, the bot user's ID and the granted scopes, and it can be rotated: without rotation the token never expires; with rotation it expires every 12 hours and each refresh returns a new, single-use refresh token.
- **A token copied by hand** from the app's settings page needs no redirect URL and no client secret, but there is no install to verify beyond `auth.test`, and no rotation.

A member's Slack account is not their ostra account. Slack's `users.lookupByEmail` finds the workspace user whose email matches (scope `users:read.email`, Tier 3: 50+ per minute); the alternative is asking each member to sign in with Slack and storing their user ID.

Sources: `docs.slack.dev/reference/methods/chat.postMessage`, `chat.update`, `users.lookupByEmail`, `auth.test`, `oauth.v2.access`, "Installing via OAuth authorization code flow", "Using token rotation", "Sending messages using incoming webhooks", "Rate limits".

## Decision

### The channel

- **Slack is a fourth `NotificationChannel`**, beside `panel`, `tracker` and `email`, delivered by `SlackNotificationAdapter` in a new Apache-2.0 `packages/adapters/adapter-slack` (ADR 0025, ADR 0048). One class, one level deep, passing the notification contract suite against a fake Slack Web API.
- **Per member, off by default.** Each member's choices gain a Slack column; `defaultChoice(kind, "slack")` is `false` for every moment. The panel's column is still always on. The install's Slack is one per organization, so a member either has the column or doesn't.
- **A DM, not a channel.** Every message is a direct message from the app's bot to one member. A shared channel would show one project's moments to every member in it, which breaks ADR 0050's audience and a restricted project's access. A "post to a channel" would be a different channel with its own audience rule, not a Slack setting.

### The install

- **Each install makes its own Slack app.** An organization admin creates the app in Slack from the manifest ostra shows, enters its client ID and client secret once, and installs it by OAuth v2. The redirect URL is `<OSTRA_PUBLIC_URL>/api/slack/callback`, and the bot scopes are `chat:write` (post and update) and `users:read.email` (match a member).
- **Not one distributable app for every install.** That would make every self-hosted install depend on a client secret and an app the project's maintainer controls, which a self-hosted product avoids. An install that would rather reuse an app it already made can: the form takes any app's client ID and secret.
- **The redirect URL must be HTTPS.** Slack's OAuth guide states it, so an install served over plain HTTP can't complete a real install. Its Slack page says so in words; the scripted run uses the fake Slack. This is a consequence of OAuth, not a choice ostra can hide.
- **One installation per organization**, in a `SlackInstallation` row (`organizationId` unique), with a state (`pending`, `active`, `failed`, `revoked`), the workspace's and bot's IDs and names, the app ID, the granted scopes, the token's date and a renewal flag. Several workspaces per organization would be a new table and a new ADR, as tracker connections were (ADR 0071).
- **The client secret, the bot token and the refresh token are references only.** The row holds `SecretRef`s; values live in the secret store in the organization's namespace, purposes `slack-client-secret`, `slack-bot-token`, `slack-refresh-token`. No page, log line, error, audit entry, adapter result or agent box ever holds one; the page shows "set"/"not set".
- **Disconnect deletes them all.** The row becomes `revoked`, every secret the installation held is deleted, and DMs stop. The workspace's name stays for history. Reinstalling reuses the row, so member choices survive a reconnect.

### Token renewal

- **With token rotation on, refresh before expiry.** An expiring access token is refreshed within 10 minutes *(working value)* of its date, and a `token_expired` answer triggers one refresh and one retry. Every refresh response carries a **new** refresh token, and the old one stops working after a short grace period; ostra writes the new access and refresh tokens in one transaction. Slack allows at most 2 active refreshed tokens, so refreshing only near expiry matters.
- **Without rotation, nothing to do.** Slack's access token never expires; the row's date is null and the check does nothing.

### The member's identity

- **Match by email, cache the match.** The workspace user whose email is the member's ostra address is their Slack account. The first delivery looks it up and writes a `SlackIdentity` row (organization, member, Slack user ID, workspace ID, matched address); later moments read it. A changed address, a deleted user or a failed lookup re-matches; no negative rows are kept, so a user added to the workspace later is found at the next moment.
- **An unmatched member is skipped, never failed.** The send reports the member in `refused` with words, the delivery is `skipped` (`no-slack-account`), and the page shows "No Slack account" beside their column. The other members' messages still go. A member the workspace doesn't know is not an error of the install.
- **Not Sign in with Slack in v1.** It would add a second OAuth flow, a user token and another table to store the link; email matching is enough for a first version, and it mirrors how the tracker channel finds a person (`findUsersByEmail`). If real workspaces show the match fails (different addresses, guests, hidden emails), explicit linking is the recorded fallback (spec section 9).

### Delivery

- **Fan-out writes a delivery per member and moment**, keyed `notify:<item>:<change>:<member>:slack`, in the same transaction as the panel's, ticket's and mail's (ADR 0011). The adapter sends each key once; the delivery row's `sent` state is the durable guard.
- **An answer or dismissal edits the message.** Each sent Slack message's `providerMessageId` is `slack:<D-channel>:<ts>`, exactly what `chat.update` needs, and the closing delivery edits it to say who answered or dismissed. A message that can't be edited (gone, or another's) is skipped `nothing-to-edit`, in words, as the tracker channel does.
- **The DM carries what a mail may carry** (ADR 0050): the moment's heading, the organization's and project's names, the task's title and key, one line and a link. Never ticket text, agent output, a plan's text, a diff, check output or a comment. `mrkdwn: false`, `unfurl_links: false` and `unfurl_media: false` keep an untrusted title literal.
- **Rate limits and retries are the queue's.** A 429 becomes `rate-limited` with Slack's `Retry-After`, and the delivery retries on its own; a failing Slack delivery never holds back another channel's. Posting is a "special" tier (about one message per second per channel, plus a workspace-wide limit); `chat.update` and `users.lookupByEmail` are Tier 3.

### What Slack doesn't do here

- **No Events API, Socket Mode, slash commands, interactivity, or answering from Slack.** Nothing comes back from Slack; the DM links to the panel. Answers stay signed-in actions (ADR 0050's no-bearer-link rule).
- **No account mails.** Invitations, verifications and resets go by email, because the person may have no account yet and the link is a bearer credential (ADR 0053).
- **No new dependency.** The client is four JSON calls on `fetch` with Zod schemas at every response. `@slack/web-api` (MIT) would be a library to pin and approve for calls ostra writes in an afternoon; its OAuth and retry helpers aren't needed.

## Considered options

- **Incoming webhooks.** Rejected: one URL, one fixed channel, no DM, no message ID, no edit or delete. It can't be a per-member channel at all, and F-057 is per member.
- **A shared channel** for the whole team. Rejected for this feature: it shows every moment to everyone in the channel, against ADR 0050's audiences and a restricted project's access. A later opt-in channel would be a separate channel, not a Slack option.
- **A distributable app for all installs.** Rejected: the client secret and app would be the distributor's, a hosted dependency in a self-hosted product.
- **A copied bot token, no OAuth.** Rejected as the primary path: no verified install beyond `auth.test`, no read-back of the granted scopes or the workspace in the same call, and no rotation. Kept as a considered fallback for installs that can't serve HTTPS (spec section 9).
- **Sign in with Slack to link accounts.** Rejected for v1: a second OAuth flow, a user token and a table, for a match email gets for free; recorded as the fallback.
- **A second row per workspace**, several Slack workspaces per organization. Rejected for now: mail is one per install and Slack is its analogue; several would repeat ADR 0071's connection work.
- **Posting through the user's own token** (`chat:write` on a user token) so messages come from the person. Rejected: each member would have to authorize ostra, and a message would appear to be written by them, which is false.
- **A Slack SDK.** Rejected above: four calls, no need for the library's surface.

## Consequences

- **The schema grows by two tables and one enum value:** `SlackInstallation` (one per organization, secret references), `SlackIdentity` (one per member), and `slack` in `NotificationChannel`. Additive only; an older release reads every row.
- **`notificationChannels` grows to four**, so every exhaustive switch over it does too: `adapterNameOf`, `channelsFor`, the delivery worker, the panel's column labels, the preferences' payload and its max, and the generated isolation test.
- **Fan-out gains one boolean** (`slackOn`: an active installation) and no lookup; the identity lookup happens at delivery and is cached. The member's box is off by default, so an install that never connects Slack writes no Slack delivery at all.
- **The closing fan-out writes edits for two channels now** (`tracker` and `slack`), so `closeNotificationsInTx` takes the editable channels from one list instead of hard-coding the tracker.
- **The panel grows Organization › Slack and a fourth column**; the emails' page gains a line that Slack is separate.
- **Secrets:** a new set of purposes in the secret store and a disconnect that deletes them. `every-record` and the isolation tests cover the two tables.
- **A live install needs HTTPS** and a Slack app its admin makes; the docs say both. The maintainer's test workspace and app are ticket 09's, and the manual run is ticket 10's.
- **Cost:** an organization admin makes a Slack app once; a member opts into each moment; no message reaches a channel or a member the workspace doesn't know.

## Amendments

- *2026-11-23:* written with the post-v1 spec; no maintainer decision taken yet.
