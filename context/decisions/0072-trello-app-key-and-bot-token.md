# Trello: an organization's app key, a bot member's token, and lists as statuses

**Status:** accepted (2026-11-23). It builds on ADR 0013 (trackers as adapters), ADR 0025 (a contract suite per kind), ADR 0043 (attachments as blobs), ADR 0047 (a tracker's own credential, never a person's), ADR 0070 (a ticket's files) and ADR 0071 (several tracker connections per organization). It governs F-153; spec: `specs/post-v1-trello/`; research: `research/trello-and-notion.md` §1, read 2026-11-23.

## Context

Trello is the next tracker after Jira (`build-order.md`: "right after" v1, when someone asks). Its shape differs from Linear's and Jira's in four ways that a spec can't leave to the builder:

- **It has no app a user installs per workspace.** The organization makes its own Trello app (a Power-Up, for an API key and secret), and a token is a **member's** grant: it reaches the whole account that granted it (`research/trello-and-notion.md` §1.2). Atlassian's OAuth 2.0 3LO (2026-09-15) is for apps with a logged-in user, uses rotating refresh tokens, and Atlassian's own advice for an app that "runs without a logged-in user" is API tokens, which "are not going away" and have "no deprecation timeline" (the 2026-09-15 announcement, cited in the research).
- **Its webhooks are the tracker's own to register.** `POST /1/tokens/{token}/webhooks/` takes the board and the callback URL; Trello checks the URL with a `HEAD` and refuses it unless it answers 200. Deliveries are signed with HMAC-SHA1 over **the body plus the callback URL exactly as registered**, keyed with the app secret; there is no per-webhook secret and no delivery-id or timestamp header (`§1.3`).
- **Its statuses are lists,** in board order, with no category on them. A move is a write of `idList`, with no transition graph (`§1.5`). A card's key is `idShort`, numbered per board and regenerated after a cross-board move; a board has no prefix (`§1.1`, §1.4).
- **A card can have several members, no email for any of them, and its uploaded files download with a credential** (`§1.4`, `§1.6`).

Three decisions follow, and one contract addition the first two force. ADR 0071 already settles connections, boards per connection, paused boards and several kinds: this ADR doesn't reopen them.

## Decision

### 1. The credential: the organization's app key + secret, and a dedicated bot member's never-expiring token

- **A connection is one Trello bot member.** An organization admin creates a Trello app on `trello.com/apps/admin` (its **Trello Auth** tab gives an API key and secret), creates a Trello member for ostra, and adds it to the boards ostra should work. The connection holds the app's key (not a secret: it travels in the consent URL and every call) and its secret (the secret store, `webhookSecretSecretRef`: the app secret's only job is signing deliveries, and the inbox already reads that ref), and the bot member's token (`accessTokenSecretRef`, `credentialKind: "trello_token"`).
- **The token is authorized by a person, once, with `expiration=never`.** The panel opens Trello's consent page with `scope=read,write&expiration=never&response_type=token&callback_method=fragment`, signed in as the bot member (or the admin pastes a token made by hand from the bot's Token link). ostra reads it back (`GET /1/members/me`, `GET /1/members/me/boards`) before storing it. No credential is stored before a pass. Nothing in ostra can mint a member's grant by itself, and that's accepted: it is a one-time setup step, like Jira's admin webhook.
- **Why not OAuth 2.0 3LO.** It acts as a signed-in user, needs a public client with a secret, rotates refresh tokens every 90 days, and Atlassian offers it beside tokens rather than in place of them. A token that never expires is exactly what an unattended, self-hosted server wants, and it doesn't add a refresh loop or a rotation failure mode to a product whose tracker connections must not silently stop. The risk that Atlassian later deprecates tokens is recorded here and in the research; the adapter's auth is one small file, so a migration would touch it and the connect steps, not the domain.
- **Why not OAuth 1.0.** It adds a signature scheme to every call for no access the token doesn't already give.
- **Why a dedicated bot member, never a person's token.** A token reaches the whole granting account (`§1.2`). The bot member is only on the boards ostra works, so a mistake in a board's URL or a scope can't reach a person's private boards, and the member's own writes are how ostra recognises its echoes.
- **One connection per bot member.** The organization may hold several Trello connections (two clients, two bot members), each with its own key and token, as ADR 0071 allows for trackers. A second connection of the same member is refused by the m11 per-site index, naming the holder. Two connections may share one app key, and their key budget is shared (300 requests per 10 s per key).
- **Storage.** `Connection` gains `apiKey` (String, null) for the key. The secret is `webhookSecretSecretRef` and the token `accessTokenSecretRef`, both in the secret store; neither ever reaches a log line, an error, a member's payload or a box. `appId` and `externalWorkspaceId` are the bot member's Trello ID, `externalWorkspaceKey` its username and `externalWorkspaceName` its full name. The token has no expiry date, so the Jira columns stay null and the panel draws no token date.
- **Revoking.** `DELETE /1/tokens` revokes the token at Trello, and a revoked token answers 401; a saved token that answers 401 fails the connection (`token-refused`) and pauses its boards (ADR 0071). Disconnecting also deletes ostra's webhooks and the stored secrets.

### 2. The webhook: ostra registers it on the board, and verifies the body plus the callback URL

- **ostra registers and deletes its own webhooks.** The interface gains `webhookRegistration`, `ensureBoardWebhook(board, callbackUrl)` and `removeBoardWebhook(board, callbackUrl)`; the adapter lists the token's webhooks and creates one per attached board (`idModel` the board, `description` ostra's marker) only when none matches, and deletes by callback URL. Registration is core's, at attach, activation, `Re-register webhooks`, detach and disconnect: registration is per board, not per connection, so no column stores it and a failure is a retried job and a needs-you item, never a failed activation.
- **The route answers `HEAD`.** Trello checks the callback with `HEAD` and creates nothing unless it answers 200 (`§1.3`). `HEAD /webhooks/trello/<connectionId>` answers 200 for a connection that isn't revoked (404 unknown, 410 revoked), beside the `POST` that takes deliveries.
- **The signature is over the raw body and the callback URL as registered.** `TrackerWebhookRequest` gains `callbackUrl`, the exact string ostra registered, derived in one place from `OSTRA_CORE_PUBLIC_URL` and the connection's ID. The adapter computes base64 HMAC-SHA1 over the raw body bytes followed by that string, with the app secret, compared constant-time. Re-serialized JSON, a changed public URL or a wrong secret all fail. There is no delivery-id or timestamp header; the delivery ID is `action.id`, and `action.date`, when present, is the freshness input (30 minutes, since Trello's retries come 30, 60 and 120 s later).
- **Without a public HTTPS address, ostra polls.** No registered webhook, no deliveries: every attached Trello board is polled and the 5-minute backstop still runs. The webhook path is the fast one, not the correctness one, and the Inbox shows a change within 60 seconds by polling alone. This keeps F-042 (private installs) true for Trello.
- **Changing `OSTRA_CORE_PUBLIC_URL` needs a re-registration.** The signature covers the registered URL, so an address change invalidates every old delivery. The connection's page offers `Re-register webhooks`, and the configuration reference says the address is part of the signing material, not just a route.

### 3. The status: a list, mapped by the admin, written directly

- **Lists are statuses.** `listStatuses` reads the board's lists in `pos` order; a card's status is its `idList`. A board's mapping names each step's list, and `statusCategories` (a new optional record in `Board.statusMap`) names every list's category. Lists carry no category, so the adapter's name guess is only a draft: `listStatuses` and every ticket it returns carry the admin's category when the board's mapping has one, and the guess otherwise. The admin can map every list, including a "Blocked" list that is `started` but never a step.
- **Moves are field writes.** `moveTicket` and `updateStatus` write `idList` in one call and answer `via: []`. There are no transitions (`transitions: false`, `statusGraph: false`), so `readWorkflow` is `unsupported`, the panel draws no transition lines, and a status is always reachable. Ticket sync's "stays put" case doesn't exist on Trello.
- **The key is the board's prefix plus `idShort`.** A Trello board has no key, so the admin gives one at attach, stored in `Board.key` (`TR`), and the adapter returns `TR-12`; the stable ID remains the card's `id`, and the cache keys on it, because `idShort` is regenerated after a cross-board move (`§1.1`). `BoardRef` gains optional `keyPrefix` and `statusCategories` so the adapter sees the admin's settings; `boardRefOf(board)` is the one place every caller builds it. A key whose prefix isn't the board's is `not-found`, and a stable ID is always preferred.
- **Done is moved by ostra, always.** `detectCodeHostIntegration` answers not installed (Trello's GitHub Power-Up wasn't researched), so `doneBy` defaults to `ostra`; `magicWords: false` because Trello links a PR by the attachment ostra makes, not by a word in the body.

### 4. What a card is not

- **Sub-issues:** a checklist item isn't a card, and a card converted from one isn't linked as its child (`§1.4`). `subIssues: false`; checklist items are appended to the ticket's description as Markdown.
- **Mentions:** a token reads only the granting member's email (`§1.6`). `mentions: false`; `findUsersByEmail` stays `unsupported`, and the Inbox and the prompt don't offer a mention.
- **One assignee:** a card has several members and ostra models one. The first member is `assignee`; the rest aren't modelled (an open question proposes an `assignees` list if the maintainer wants it).
- **Priority:** none, `null`.
- **Files:** uploaded attachments are the ticket's files, fetched with the key and token sent only to `api.trello.com`; a link attachment and a link in the text are never fetched. The contract's "no redirect is followed" becomes "at most one hop, to the tracker's own storage, without the credential", which is what a Trello upload may need (unverified; the live run confirms it).
- **Comments:** `commentCard` actions are comments, unthreaded. ostra edits its own in place; a person's edit is corrected on the next context read and the webhook delivery carries it when there is one.

### 5. The contract additions (all additive)

- `TrackerWebhookRequest.callbackUrl?: string`.
- `TrackerCapabilities.webhookRegistration: boolean`; `ensureBoardWebhook` and `removeBoardWebhook`, `unsupported` without it.
- `BoardRef.keyPrefix?: string` and `BoardRef.statusCategories?: Readonly<Record<string, TicketStatusCategory>>`.
- `ConnectionKind` + `trello`; `ConnectionCredential` + `trello_token`; `Connection.apiKey`.
- `boardMappingSchema.statusCategories`.
- Two settings: `OSTRA_TRELLO_API_URL` and `OSTRA_TRELLO_AUTHORIZE_URL`, both defaulting to Trello's own; only tests set them.

No constraint is dropped, no column removed, and no row rewritten. Every subject of the tracker contract suite implements the new members in the same commit (adapter parity, `AGENTS.md`).

## Considered options

- **Trello's OAuth 2.0 3LO.** Rejected for now: a logged-in-user flow with a rotating refresh token, for an unattended server, when Atlassian states tokens have no deprecation timeline. Revisit on a date.
- **One connection per API key.** Rejected: several clients on Trello need several bot members, and an app key is the organization's, not the client's. The connection's identity is the bot member, and the key is a column beside it.
- **An admin-made, admin-registered webhook** (Jira's pattern). Rejected: Trello's API registers one from the token, so requiring an admin step would be a step Trello doesn't need and a place to make a mistake. It also keeps the secret in ostra's hands from the start.
- **A per-webhook secret.** Not possible: Trello signs with the app secret and has no per-webhook one.
- **Verifying the body alone.** Wrong: Trello signs the body **and** the callback URL. A verifier without the URL would reject every real delivery (or, worse, accept a replayed one from another route).
- **Reading the webhook URL from the request's `Host` header.** Rejected: behind a proxy it differs from what was registered, and the signature would fail with no useful explanation. The URL is derived from the setting that registered it.
- **Mapping lists by name only.** Rejected: a board's lists are named by people ("Sprint", "QA", "Shipped"), and a wrong category moves tickets wrongly in the Inbox and in intake rules. The admin maps every list; the guess is a draft.
- **Treating checklists as sub-issues.** Rejected: they aren't cards, aren't linked, and a child task would have no ticket to move.
- **Mentions by Trello username.** Rejected: ostra has members' emails, not Trello usernames, and the token can't read anyone's email. A mapping by username would need its own design and a member's consent.
- **A new table per tracker kind.** Rejected in ADR 0071 and still: the connection row is shared, the kind's columns are nullable, and the domain reads a discriminated union.

## Consequences

- **The panel's Trello tile stops saying "Coming soon",** and Notion's stands alone; the picker, a Trello connection's page, its boards' prefix and list mapping, and every ticket's mark are new screens or additions (spec section 13). Trello's mark already exists.
- **Core's webhook inbox, registration and poller gain a third kind,** and `verifyOnlyTrackers` a Trello verifier; a delivery's callback URL is computed once and passed to every verifier (the other kinds ignore it).
- **Every caller that builds a `BoardRef` moves to `boardRefOf`,** so a Trello board's prefix and categories reach the adapter; the ticket cache and the prompt need no override of their own.
- **A board's prefix is required on attach and unique in its project,** a small refusal the Boards page shows in place.
- **A public address is signing material,** not only a route: changing it needs `Re-register webhooks`, and the docs say so. The cost is one button and one line.
- **Two settings** ship with working defaults; a fresh install connects Trello by polling with only the required settings.
- **The live run is the only proof of five unverified vendor details** (the download's redirect, the board-cards paging, the payload's field names, the size limits, the description's images). Until it runs, the fake defines the contract and the panel's state covers a real account that answers differently (spec section 11).
- **An API-token deprecation would reopen this ADR** and the connect steps, but not the domain, the boards or the ticket flows.

## Amendments

- *2026-11-23:* written with the post-v1 Trello spec.
