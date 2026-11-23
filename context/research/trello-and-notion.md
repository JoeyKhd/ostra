# Research: Trello and Notion as trackers

**Status:** Research v1 · **Checked:** 2026-11-23 (every source below was read on this date) · **Informs:** no open question yet; a later tracker ADR, beside ADR 0013 and ADR 0047

The question: could ostra support **Trello** and **Notion** as trackers through its existing `TrackerAdapter` (`packages/adapter-sdk/src/tracker/base.ts`, `capabilities.ts`)? Linear and Jira were assessed the same way in `trackers.md`.

Facts come from primary sources: Atlassian's Trello developer docs and changelog, Atlassian's own announcements on its developer forum, and Notion's developer docs. Each fact links its source, and the list at the end has them all. Anything that couldn't be confirmed is marked **unverified**. Recommendations are marked as such and are not decisions.

---

## Summary

**Trello**
- **Auth fits the Jira pattern.** The organization creates its own Trello app (an API key and secret) and a token for a dedicated bot member, which never expires. Atlassian's OAuth 2.0 3LO for Trello (2026-09-15) is for apps with a logged-in user: Atlassian itself points unattended server apps at API tokens, which "are not going away".
- **Webhooks are the easy part.** ostra registers them itself through the API, on the board. They're signed with HMAC-SHA1 over the body plus the callback URL, using the app secret. They need a URL Trello can reach that answers a `HEAD` check.
- **The ticket maps cleanly.**
  - Card name and description (Markdown), comments (`commentCard` actions), labels, members, attachments and checklists.
  - Lists are the statuses. A move is `PUT /cards/{id}` with `idList`, with no transition graph.
- **Limits are generous.** 100 requests per 10 s per token, and 300 per 10 s per API key, which is the organization's own.
- **What's awkward:**
  - Cards have several members, not one assignee.
  - Lists have no categories, so the admin maps each one.
  - A checklist item isn't a ticket.
  - A member's email can't be read, so there are no mentions.
  - Uploaded files download only with an OAuth-style `Authorization` header.
- **Verdict (recommendation):** a small adapter, smaller than Jira's. Build it after Jira, when someone asks for it.

**Notion**
- **Auth:**
  - A workspace owner creates an **internal connection** with a static token, and shares the tickets database with it.
  - The connection's capabilities are set by hand: read, update and insert content; read and insert comments; and user information with email addresses.
- **Webhooks are weaker than the other three trackers':**
  - Subscriptions are created only in the connection's settings UI.
  - Each one needs a one-time verification token pasted back by hand. That token then signs deliveries (HMAC-SHA256).
  - The endpoint must be public HTTPS.
  - Deliveries are **at-most-once**, arrive out of order and carry IDs, not content.
  - So the reconcile poll carries correctness, and webhooks only make things faster.
- **Every database is its own schema.** A "board" is a **data source** (API version 2025-09-03). The admin maps which properties are the status, the assignee, the labels and the key. The title is fixed.
  - The status property has three fixed groups (To-do, In progress, Complete), which give each option its category.
  - A select property used as a status has no groups, so the admin maps every option.
- **Markdown is now first-party:**
  - `GET /v1/pages/{id}/markdown` returns a page's body as Markdown. Files in it come with pre-signed URLs that expire.
  - Comments take Markdown too, but only inline Markdown: lists, headings and code blocks don't render in a comment.
- **Limits are tight.** 180 requests a minute per connection (600 on Business and Enterprise), plus about 3 data-source queries a second.
- **Verdict (recommendation):** a medium-to-large adapter, about Jira's size or more. Most of the cost is a property-mapping step at connect time and a verification step for the webhook. Build it later, behind a spike, when there's demand.

| Capability (`TrackerCapabilities`) | Linear (built) | Jira (ADR 0047, fake) | Trello | Notion |
|---|---|---|---|---|
| `agentSessions` | yes | no | no | no |
| `subIssues` | yes | yes | no (checklists aren't cards) | no at first; possible with a mapped self-relation |
| `statusGraph` | no | yes | no | no |
| `webhooks` | yes | yes | yes, with public HTTPS | yes, with public HTTPS; at-most-once |
| `commentEdit` | yes | yes | yes | yes |
| `attachments` | yes | yes | yes (the marker has to live in the name) | no at first |
| `transitions` | no | yes | no | no |
| `mentions` | yes | yes | no (emails unreadable) | yes, with the email capability |
| `agentScopes`, `agentSessionLink` | set | none | none, `false` | none, `false` |
| `ticketFields.acceptanceCriteria` | no | yes | no | no at first (a mapped text property could hold it) |
| `ticketFiles` | `all` | `all` | `all` | `all` |

Linear's and Jira's columns are read from `adapter-linear/src/linear-adapter.ts` and `adapter-sdk/src/testing/jira-fake.ts`.

---

## 1. Trello

### 1.1 REST API

| Topic | Finding | Source |
|---|---|---|
| Base URL | `https://api.trello.com/1/...`. Singular and plural routes both work. | [API intro](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/) |
| Model | Cards live in lists, and lists live on boards. Boards belong to a member or a Workspace. "Recursion helpers" fetch nested content in one call (`GET /1/members/me/boards?actions=all`). | [API intro](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/) |
| Request bodies | "Query parameters may also be replaced with a JSON request body." | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| Identifiers | Cards have an `id` and a `shortLink`. `card.idShort` (the `#12` on a board) "will always be regenerated after cross-board moves" from 2024-08-01, so apps should store `id`. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/), [changelog 2024-07-22](https://developer.atlassian.com/cloud/trello/changelog/) |

### 1.2 Authentication for a self-hosted app

| Option | What it is | Fit for ostra | Source |
|---|---|---|---|
| **API key + token** ("Trello Auth") | A key comes from a Trello app ("Power-Up") on the admin page `trello.com/apps/admin`, under the **Trello Auth** tab. "For generating an API key, you first need to have created a Trello Power-Up." A user token comes from `https://trello.com/1/authorize` with the parameters `scope` (`read`, `write`, `account`), `expiration` (`1hour`, `1day`, `30days`, `never`), `key`, `response_type=token`, and an optional `return_url` with `callback_method` (`postMessage` or `fragment`). A token can also be generated by hand from the "Token" link next to the key. It's sent as `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"`, as query parameters, or in the body. | **Best fit.** A token for a dedicated bot member, `read,write`, `expiration=never`: the Trello counterpart of Jira's service account (ADR 0047). | [Authorization](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/), [API intro](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/) |
| OAuth 1.0 | "The Trello API supports basic OAuth 1.0", signed with the app secret from the Trello Auth tab. | No reason to use it over a token. | [Authorization](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/) |
| **OAuth 2.0 (3LO)** | Announced 2026-09-15. Uses `authorization_code` and `refresh_token` grants only: "We won't be supporting grant types like client credentials." Refresh tokens rotate ("rotating refresh tokens every 90 days"). Clients are public or confidential, configured on the app's OAuth 2.0 tab, with granular scopes such as `read:board:trello` and `write:board:trello`. Power-Up clients are workspace-restricted. Non-Power-Up apps "do not have this restriction." Access tokens last one hour (**unverified**: from a search snippet of the confidential-client guide, which wasn't read). | **Not now.** It acts as a signed-in user, and Atlassian's own advice is that if "your app runs without a logged-in user", API tokens are "your best option". | [OAuth 2.0 announcement](https://community.developer.atlassian.com/t/oauth-2-0-3lo-is-now-available-for-trello/102691), [OAuth 2.0 client configuration](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-client-configuration/) |

- **Tokens stay.** "API tokens are not going away", and "There's no deprecation timeline" ([announcement, 2026-09-15](https://community.developer.atlassian.com/t/oauth-2-0-3lo-is-now-available-for-trello/102691)). The changelog of 2025-04-16 had said Trello plans to "replace its current authorization mechanism with OAuth 2.0" ([changelog](https://developer.atlassian.com/cloud/trello/changelog/)). The later announcement is the one to go by, but the risk is real.
- **A token reaches the whole account.** "Tokens for users should always be securely stored as they grant access to the entire user's account!" ([Authorization](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/)). So the token belongs to a bot member that's only on the boards ostra works, never to a person.
- **Revoking:** a token is revoked from the user's account page, or with `DELETE /1/tokens`. A revoked token answers 401 "invalid token" ([Authorization](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/)).
- **Terms.** The Trello pages read here have no rule like Jira's, which forbids "collect[ing] API tokens or instruct[ing] customers to create individual 3LO apps" (`trackers.md` §2.2). The Trello Developer Terms themselves weren't read, so whether they say anything about a self-hosted tool holding a token is **unverified**.
- **Unverified:**
  - whether creating a Trello app needs a Workspace, and who may create one;
  - whether a bot member costs a seat on a paid Workspace.

### 1.3 Webhooks

Source: [Webhooks](https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/), unless noted.

| | Finding |
|---|---|
| Create | `POST /1/tokens/{token}/webhooks/` with the key, `callbackURL`, `idModel` and `description`. With OAuth 2.0, it's `POST /1/webhooks` with a bearer token. **ostra can register them itself**: no admin step, unlike Jira's admin webhook or Notion's UI. |
| What it watches | Any model that actions apply to: board, card, list, member, Workspace (organization), and Enterprise. A board webhook covers every card on the board. |
| Check at creation | Trello sends `HEAD` to `callbackURL`, and the webhook isn't created unless the answer is 200. An invalid SSL certificate blocks it. ostra's webhook route must answer `HEAD`. |
| Signing | The `X-Trello-Webhook` header is the base64 HMAC-SHA1 of **the body concatenated with the `callbackURL` exactly as registered**, keyed with the app secret from the Trello Auth tab (the OAuth 2.0 client secret for OAuth 2.0 webhooks). |
| Payload | A POST with `action`, `model` and `webhook`. |
| Delivery ID, timestamp | There's no delivery-ID header and no timestamp header in the doc. The action's `id` and `date` are the natural ones (the field names in the payload are **unverified** beyond `action`). |
| Retries | 3 retries, after 30, 60 and 120 s. |
| Disabled | After failures that last **30 days** and number **over 1,000**, both at once. "May change without notice." One success resets the count. |
| Deleted | By `DELETE`, by the callback answering **410 Gone**, or when the token is revoked or expires. An OAuth 2.0 webhook survives its access token's expiry and dies only when the grant is revoked. |
| Network | "SSL to port 443". Deliveries come from `104.192.142.240/28`. The doc doesn't say "public" in words, but Trello's servers must reach the URL for the `HEAD` check, so a private install needs a tunnel (as for Linear, ADR 0013). |
| Echo | `X-Trello-Client-Identifier`, sent on ostra's own API calls, "is echoed back to webhooks from the same application key". That's a clean echo check, beside comparing the acting member with the bot member. |
| How many | "There is no limit to the number of webhooks you can set up in Trello." ([API intro](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/)) |

**Action types** ([action types](https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/)):
- **The ones a ticket needs:** `createCard`, `updateCard` (a move between lists is an `updateCard`), `commentCard`, `addAttachmentToCard`, `addChecklistToCard`, `updateCheckItemStateOnCard`, `addMemberToCard`/`removeMemberFromCard`, `deleteCard`, `moveCardToBoard` and `convertToCardFromCheckItem`.
- **Only in webhook data:** `updateComment`, `deleteComment`, `addLabelToCard` and `removeLabelFromCard` are "excluded". They're "not returned in requests to nested resources", so a poller never sees a comment edit or a label change as an action. It sees them only through the card's own fields.
- **Unverified:** the fields that show a list move, `data.listBefore`/`data.listAfter` and `data.old.idList`. The page doesn't describe them.

**Without a public URL, ostra polls.**
- **Actions:** card and action queries return at most 1,000 results, and page with `before` and `since`, which take a date or an action ID ([API intro](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/)). One board-actions query with `since` set to the last action seen catches the new cards, moves and comments in one call.
- **The poll can't see everything.** Label changes and comment edits aren't returned as actions (above), so a reconcile also compares the cards' fields.
- **Unverified:** the exact board-actions route and its `filter` values. The cards reference lists `filter` and `page` on `GET /cards/{id}/actions` ([Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/)).

### 1.4 Mapping a card to a `Ticket`

| `Ticket` / `TicketContext` | Trello | Source |
|---|---|---|
| `externalId` | card `id` | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `key` | Trello has no key: a board has no prefix. **Recommendation:** an admin-set prefix per board plus `idShort` (`TR-12`). It changes when the card moves board, which is the same contract as Linear's and Jira's keys (`TicketRef`: the stable ID is preferred). | [changelog 2024-07-22](https://developer.atlassian.com/cloud/trello/changelog/) |
| `title`, `description` | `name`; `desc` is Markdown (Trello updated its card editor's Markdown parsing on 2025-04-11). The `desc` length limit is **unverified**. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/), [changelog](https://developer.atlassian.com/cloud/trello/changelog/) |
| `status` | the card's list, `idList` (§1.5) | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `url`, `updatedAt` | `url` (or `shortUrl`), `dateLastActivity` | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) (sample response) |
| `priority` | none (only through custom fields, not researched): `null` | — |
| `labels` | `idLabels`, resolved to the board's label names | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `assignee` | `idMembers` is a **list**. Trello has no single assignee, so the adapter takes the first member, or none. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `comments` | `commentCard` actions on the card (`GET /cards/{id}/actions`). Trello comments aren't threaded, so `parentId` is always `null`. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/), [action types](https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/) |
| `attachments`, `files` | `GET /cards/{id}/attachments` gives `id`, `name`, `url`, `mimeType`, `bytes`, `isUpload` and `previews`. A link attachment (a PR) stays a link, and an upload is a file. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `images` inline | Images in `desc` are Markdown image links. That they point at the card's own attachment URLs is **unverified**. | — |
| `parent`, `children` | none: Trello has no card hierarchy. **Checklists** (`GET /cards/{id}/checklists`) are items on the card, not cards. They belong in the prompt as part of the description, not as sub-issues. A checklist item can be turned into a card in Trello (`convertToCardFromCheckItem`), but the new card isn't linked as a child. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/), [action types](https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/) |
| `linked` | none natively (card-link attachments weren't researched) | — |

**Downloading files**
- **The route:** an uploaded attachment's `url` points at `https://api.trello.com/1/cards/{idCard}/attachments/{idAttachment}/download/{fileName}`. "Making a GET request with the key and token in the `Authorization` header will return the hosted file." Query-parameter auth for downloads was "turned off on January 25, 2021" ([Trello announcement, 2020-12-09](https://community.developer.atlassian.com/t/update-authenticated-access-to-s3/43681)).
- **File names:** use `fileName` or the URL's path, not `name`, which can change (same source).
- **Unverified:**
  - whether the route answers with a redirect to a signed storage URL. Users in that thread report S3's "request signature we calculated does not match" error, which is what a client gets when it forwards its `Authorization` header to S3 on a redirect;
  - how a download authenticates with an OAuth 2.0 bearer token.
- **Consequence for `downloadFile`:** it sends the credential only to `api.trello.com`. If Trello redirects, the adapter follows that one hop **without** the header, which the base class's "no redirect is followed" doesn't yet allow. This needs a spike.

### 1.5 Status: lists

- **A list is a status.** A board's lists are its statuses, in their board order. Lists carry no category, so every list is mapped by the admin to `open`, `started`, `done` or `cancelled`, and to the board's `started`, `in-review` and `done` steps (`StatusMapping`). The default can guess from the names (`To Do`, `Doing`, `Done`), but it's a guess.
- **A move is a field write.** `PUT /cards/{id}` takes `idList` (and `pos`), so `moveTicket` and `updateStatus` both write the card's list ([Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/)). There are no transitions, so `transitions: false` and `statusGraph: false`, as for Linear.
- **Archived** (`closed`) cards: how they map (`cancelled`, or out of the board) is the adapter's choice. That `closed` means archived is **unverified** from the pages read.

### 1.6 Writing back

| Operation | Trello | Source |
|---|---|---|
| `comment` | `POST /cards/{id}/actions/comments`. The new action's `id` is the comment's ID. The text parameter and its length limit are **unverified** (the page shows only the index). | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `updateComment` | `PUT /cards/{id}/actions/{idAction}/comments`. Whether only the author can edit a comment is **unverified**, but ostra only edits its own. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `linkPullRequest`, `linkTask` | `POST /cards/{id}/attachments` with `url` and `name`: a link attachment, like Linear's URL attachment. It's linked "once per URL" by listing the attachments first. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `attachFile`, `listAttachments` | `POST /cards/{id}/attachments` with `file`, `name`, `mimeType` (and `setCover`). An attachment has a `name` but no subtitle, so ostra's marker would have to live in the name. The upload size limit is **unverified**. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `updateStatus`, `moveTicket` | `PUT /cards/{id}` with `idList` | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `createTicket` | `POST /cards` with `idList` (required), `name`, `desc`, `idMembers`, `idLabels` and `pos`. Scope `write:board:trello`. | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `updateTicket` | `PUT /cards/{id}` with `desc` | [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/) |
| `findUsersByEmail` | **Not possible.** "The token can only read the email of the user who granted it", even with the `account` scope. So `mentions: false`. Matching by Trello username would need its own design. | [Authorization](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/) |
| `detectCodeHostIntegration` | Not researched (Trello's GitHub Power-Up). Answer `installed: false`. | — |

### 1.7 Rate limits and pagination

Source: [Rate limits](https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/), unless noted.

- **The limits:** 300 requests per 10 s for each API key, and 100 per 10 s for each token. `/1/members/` routes have an extra 100 per 900 s, and `/1/members`, `/1/membersSearch` and `/1/search` are stricter. Nested member routes such as `/1/members/me/boards` don't count against the member limit.
- **The key limit is the organization's own.** Each organization has its own key here, so no other install shares that budget.
- **Over the limit:** a 429 with `API_TOKEN_LIMIT_EXCEEDED` or `API_KEY_LIMIT_EXCEEDED`. A key that collects over 200 429s gets 429 for the rest of its 10-s window, so backing off matters.
- **Headers:** `x-rate-limit-api-token-*` and `x-rate-limit-api-key-*`.
- **Other limits:**
  - `API_TOKEN_DB_LIMIT_EXCEEDED`: a per-token database-time budget, with no figure given.
  - `API_TOO_MANY_CARDS_REQUESTED`: fetch the cards first, then their actions.
- **Pagination:** at most 1,000 results per card or action query, paged with `before` and `since` ([API intro](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/)). `GET /cards/{id}/actions` also takes `page` ([Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/)).

### 1.8 Verdict: Trello

**Effort (recommendation): small, less than Jira's.**
- **What makes it small:**
  - The text is Markdown, with no ADF.
  - A status is a direct write, with no transitions.
  - There's no hierarchy, and ostra registers its own webhooks.
- **The new pieces:**
  - an HMAC-SHA1 check over body plus callback URL;
  - a `HEAD` answer on the webhook route;
  - a list-to-category mapping, with no categories to start from;
  - a key prefix per board;
  - downloads that might redirect.

**Capabilities:**

| Capability | Value |
|---|---|
| `agentSessions` | `false` |
| `subIssues` | `false` |
| `statusGraph` | `false` |
| `webhooks` | `true` |
| `commentEdit` | `true` |
| `attachments` | `true` (the marker goes in the name) |
| `transitions` | `false` |
| `mentions` | `false` |
| `agentScopes` | `[]` |
| `agentSessionLink` | `false` |
| `ticketFields.acceptanceCriteria` | `false` |
| `ticketFiles` | `"all"` |

**The admin's connect flow:**
1. Create a Trello app on `trello.com/apps/admin`, open its **Trello Auth** tab, generate an API key, and copy the key and the secret.
2. Create a Trello member for ostra, and add it to the boards ostra should work.
3. In ostra, paste the key and the secret. ostra opens Trello's authorize page (`scope=read,write`, `expiration=never`), and the bot member presses Allow. Pasting a token made by hand from the "Token" link is the alternative.
4. Pick a board. ostra lists its lists, and the admin maps each to a category and to the started, in-review and done steps, and sets the board's key prefix.
5. ostra registers a webhook on the board when the install has a public HTTPS URL. Otherwise it polls the board's actions.

**The awkward parts:**
- one card, several members;
- lists without categories;
- checklists that aren't tickets;
- no emails, so no mentions;
- label changes and comment edits invisible to a poller;
- a file download that may redirect;
- the OAuth 2.0 migration Atlassian may still push, despite "no deprecation timeline".

**Recommendation:** worth doing, and cheap. Do it after Jira (ADR 0013's order), when a user asks for it. Use a bot member's key and token, and revisit OAuth 2.0 only if Atlassian sets a date for tokens.

---

## 2. Notion

### 2.1 API

| Topic | Finding | Source |
|---|---|---|
| Base URL and headers | `https://api.notion.com`, with `Authorization: Bearer <token>` and `Notion-Version`. IDs are taken "with or without dashes". | [Intro](https://developers.notion.com/reference/intro) |
| Versions | Data sources arrived in `2025-09-03`. The Markdown guide's examples use `2026-03-11`. | [Upgrade guide 2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03), [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content) |
| Databases and data sources | A database now "contain[s] multiple linked data sources", each with its own schema. `GET /v1/databases/{id}` lists its `data_sources`. `GET /v1/data_sources/{id}` is "the new home for … the properties (schema)". A page is created with `parent: { type: "data_source_id", data_source_id }`. | [Upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03) |
| Old versions break | A connection on an older version fails once someone adds a second data source to a database: creating pages, reading and querying, and writing relations all fail, and "existing connections will not see any search results for that database". ostra must use `2025-09-03` or later from the start. | [Upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03) |
| Query | `POST /v1/data_sources/{id}/query` filters by property (`status` `equals`, `people` `contains`) and by `last_edited_time` (`on_or_after`), and sorts by `last_edited_time` ascending. Filtering by status *group* needs the beta header `Notion-Beta: status-group-filters-2026-10-06`. `filter_properties` trims the returned properties. | [Query a data source](https://developers.notion.com/reference/query-a-data-source) |

**The board is a data source, not a database.** A database can grow a second data source with another schema, so the adapter's `BoardRef` is the data source ID.

### 2.2 Authentication for a self-hosted app

| Option | What it is | Fit for ostra | Source |
|---|---|---|---|
| **Internal connection** | "You are required to be a workspace owner to create a connection." It's created in the Developer portal. It "sends the same token in every API request", and no expiry is documented. A page "must be manually shared with the connection" (••• → Add connections). | **Best fit.** It's the organization's own, scoped to what it's shared, and writes as a bot. | [Authorization](https://developers.notion.com/docs/authorization) |
| Personal access token | "A PAT acts as the user who created it and uses that user's permissions." | No: a person's token, which ostra doesn't collect (as with Jira, ADR 0047). | [Authorization](https://developers.notion.com/docs/authorization) |
| Public / OAuth connection | Authorization at `https://api.notion.com/v1/oauth/authorize` (`owner=user`) and `…/v1/oauth/token` with HTTP Basic client credentials. It returns `access_token`, `refresh_token` and `bot_id`, and a refresh rotates both. "Only that user is able to interact or share pages and databases with the connection." Marketplace review "is not required". | Not for v1 of the adapter. One user's grant governs what ostra sees, and the organization would register its own OAuth app for nothing more than the internal connection gives. | [Authorization](https://developers.notion.com/docs/authorization) |

- **Capabilities are set on the connection:**
  - **Content:** read, update and insert.
  - **Comments:** read and insert.
  - **Users:** no information, information without email, or information "including … their email address". User information covers "List all users and Retrieve a user".
  - ostra needs all the content and comment capabilities, plus users with email for mentions ([capabilities](https://developers.notion.com/reference/capabilities)).
- **Terms:** an internal connection is Notion's own route for a workspace's own tool. No rule against a self-hosted tool holding its token was found in the pages read. The terms themselves weren't read (**unverified**).
- **Unverified:**
  - whether sharing a database with the connection shares every page in it (the docs read say "shared … page by page");
  - whether an internal connection's token ever expires.

### 2.3 Webhooks

Sources: [Webhooks](https://developers.notion.com/reference/webhooks), [Event types and delivery](https://developers.notion.com/reference/webhooks-events-delivery).

| | Finding |
|---|---|
| Create | **Only in the UI:** the connection's settings, **Webhooks** tab, "+ Create a subscription". The page names no API for it. Event types can be changed at any time, but the URL only until verification. After that, the subscription is deleted and recreated. |
| Verification | Notion POSTs a one-time `verification_token` to the URL. A person copies it into **Verify subscription**, and only then is the subscription active. |
| Signing | `X-Notion-Signature: sha256=<hex>`, the "HMAC-SHA256 hash of the request body, signed with your `verification_token`". The verification token is the signing secret. |
| URL | It "must be a secure (SSL) and publicly available endpoint. … Endpoints in localhost are not reachable." |
| Payload | `id`, `timestamp`, `workspace_id`, `subscription_id`, `integration_id`, `type`, `authors` (`person` or `bot`), `attempt_number`, `api_version`, `entity` (`id`, `type`) and `data` (`parent`, and `updated_properties` as property IDs). "Call the Notion API to retrieve the latest content." |
| Events | Pages: `page.created`, `page.content_updated`, `page.properties_updated`, `page.moved`, `page.deleted`/`undeleted` and `page.locked`/`unlocked`. Comments: `comment.created`, `comment.updated` and `comment.deleted`. Data sources: `data_source.created`, `.content_updated`, `.schema_updated`, `.moved`, `.deleted` and `.undeleted`. Plus `database.*`, `view.*` and `file_upload.*`. |
| Aggregation | Most page and data-source events are batched over about a minute: "typically under one minute". `page.created`, `page.locked` and the comment events aren't. |
| Delivery | "**At-most-once**." Events arrive "within 5 minutes", most within a minute. There are up to 8 retries with exponential backoff, the last about 24 h after the event. "Events may arrive in a different order than they occurred." |
| Comments | `comment.created` needs the read-comments capability. |
| Not stated | the timeout for the acknowledgment; whether a connection gets events only for pages it can reach (**unverified**, though likely); whether an internal connection can have webhooks at all (**unverified**: the page speaks of "connections" without saying which kinds) |

**How it fits `verifyWebhook` and `parseWebhook`**
- **Mapping:** the delivery ID is the event's `id`, the time sent is `timestamp`, and the echo check compares `authors` with the connection's own bot user.
- **A status change is visible.** `page.properties_updated` lists the changed property IDs, so the adapter can tell a status change (the mapped status property's ID) from any other edit.
- **Freshness:** retries run for a day, so a freshness window like Linear's 60 s would refuse them. Duplicates are deduplicated by `id` instead.

**The verification handshake doesn't fit the interface.**
- The first request carries no signature to check: it *is* the secret.
- ostra needs a "pending subscription" state per connection:
  1. Accept that one unsigned POST.
  2. Store the token as the connection's signing secret.
  3. Show the token to the admin to paste into Notion.
- The admin then pastes it into Notion. That's a new step beside `verifyWebhook`, which today assumes a secret already exists.

**Without a public URL, or with at-most-once delivery, ostra polls.**
- Query each mapped data source with `last_edited_time` `on_or_after` the cursor, sorted ascending ([query](https://developers.notion.com/reference/query-a-data-source)). That's `listTickets({ updatedSince, order: "updatedAt" })` exactly.
- Because delivery is at-most-once, the reconcile poll is what guarantees nothing is missed. Webhooks only make ostra react sooner.
- **Unverified:** whether `last_edited_time` is rounded (to the minute), which would need an overlap on the cursor. The query page doesn't say. The interface already asks with an overlap.

### 2.4 The schema: what the admin maps

Every data source has its own properties. ostra reads them from `GET /v1/data_sources/{id}` ([upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03)), and the admin maps them once per board. Source for the property facts: [property object](https://developers.notion.com/reference/property-object).

| Ticket field | Property the admin picks | Notes |
|---|---|---|
| `title` | none needed | "Every data source must have exactly one" title property, and its ID is always `title`. |
| `status` | a **`status`** property (preferred) or a **`select`** | A status property has `options` and `groups`, each group with `option_ids`. Its groups are `To-do`, `In progress` and `Complete`, which map to `open`, `started` and `done`. Options can be changed through the API, but "Group definitions themselves are managed in Notion." No group means `cancelled`, so the admin marks a "Cancelled" option by hand. A select has only options, so every option is mapped by hand. |
| `assignee` | a `people` property (optional) | Several people per value, up to 100 ([limits](https://developers.notion.com/reference/request-limits)). The adapter takes the first. |
| `labels` | a `multi_select` (optional) | option names |
| `key` | a `unique_id` property (optional) | It has a `prefix` (`TASK`), and Notion assigns the number, which "you cannot write". `TASK-12` is a natural `TicketKey`. Without one, the key falls back to a short form of the page ID. |
| `parent`, `children` | a `relation` property to the same data source (optional) | Notion's "sub-items" being a self-relation is **unverified** from the API docs read. A relation can take 100 pages per request ([limits](https://developers.notion.com/reference/request-limits)). The query page advises retrieving a page property when a relation "contains more than 25 references", so long relations need an extra call. |
| `priority` | a `select` (optional) | Options mapped to 1–4. |
| PR and task links | a `url` property (optional) | §2.6 |

- **Map by ID, not by name.** "A property's `id` stays the same when its name changes", and so does a select option's ID. The mapping stores IDs.
- **Re-check on schema changes.** `data_source.schema_updated` (its `data.updated_properties` names what changed, as `id`, `name` and `action`) tells ostra to check the mapping again. A deleted status property shows as a broken connection, not as silent failure.
- **Listing boards:** listing the data sources a connection can reach would go through search (**unverified**: the search endpoint wasn't read). Pasting the database's URL works without it: `GET /v1/databases/{id}` then lists its data sources.

### 2.5 Mapping a page to a `Ticket`

| `Ticket` / `TicketContext` | Notion | Source |
|---|---|---|
| `externalId` | the page ID | — |
| `description` | **`GET /v1/pages/{id}/markdown`** with `markdown_version=v2` ("Enhanced markdown (`v1`) is deprecated"). This is a first-party Markdown export, so the adapter needs no block-to-Markdown converter of its own. | [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content) |
| … large pages | Pages over about 20,000 blocks come back with `"truncated": true` and `<unknown url="…"/>` tags, and `unknown_block_ids` can be fetched one by one. Blocks the connection can't see also come back as `<unknown>`. Link previews, breadcrumbs and templates show as `<unknown … alt="block_type"/>`. Child pages show as `<page url="…">title</page>`. | [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content) |
| `images`, `files` | In the Markdown, images are `![caption](url)`. File blocks (image, file, video, audio, PDF) carry "pre-signed URLs" that "expire after a short period". A Notion-hosted file object's URL "is valid for one hour", with an `expiry_time`. "Don't cache … To refresh access, re-fetch the file object." Files also live in `files` properties. | [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content), [file object](https://developers.notion.com/reference/file-object), [files and media](https://developers.notion.com/docs/working-with-files-and-media) |
| `comments` | `GET /v1/comments?block_id=<page or block id>`: a flat list, oldest first, where `discussion_id` groups a thread (the adapter's `parentId`). The page size is at most 100. **Resolved comments can't be read**, and a comment on a block needs that block's ID, so reading every inline comment means walking the page's blocks. | [Comments](https://developers.notion.com/docs/working-with-comments) |
| `status`, `assignee`, `labels`, `key`, `parent` | the mapped properties (§2.4) | [Property object](https://developers.notion.com/reference/property-object) |
| `url`, `updatedAt` | the page's URL and `last_edited_time` (**unverified**: the page object itself wasn't read) | — |
| `linked` | other relation properties, if mapped (not researched) | — |

**What `downloadFile` needs for Notion**
- **The token stays home.** The URL is pre-signed, so the download needs no Notion token, and the adapter must **not** send one to the file host. Which host that is (an S3 domain) is **unverified**.
- **URLs expire.** One that outlives its hour is refreshed by reading the page again. A task that starts late re-reads the context instead of keeping old URLs.

### 2.6 Writing back

| Operation | Notion | Source |
|---|---|---|
| `comment` | `POST /v1/comments` with `parent.page_id` and `markdown` (or `rich_text`). A reply in a thread uses `discussion_id`. A new discussion anchored to selected text isn't supported. **Comment Markdown is inline only:** "fenced code blocks, headings, lists, tables, and blockquotes [do] not render as structured blocks in comments." A comment shows "using your connection's name and icon". | [Comments](https://developers.notion.com/docs/working-with-comments) |
| `updateComment` | `PATCH /v1/comments/{comment_id}` with `markdown` or `rich_text`. Delete is `DELETE`, and "a connection can only delete comments that it created". | [Comments](https://developers.notion.com/docs/working-with-comments) |
| `findUsersByEmail` and mentions | The user endpoints return emails only with the "including email addresses" capability. A comment's Markdown mentions a user as `<mention-user url="…">name</mention-user>`. The exact `url` form is **unverified**. | [Capabilities](https://developers.notion.com/reference/capabilities), [Comments](https://developers.notion.com/docs/working-with-comments) |
| `updateStatus`, `moveTicket` | Write the mapped status (or select) property by option ID or name. It's a direct write, with no transitions. | [Property object](https://developers.notion.com/reference/property-object) |
| `linkPullRequest`, `linkTask` | Notion has no link attachments. The options: a mapped `url` property, which holds one URL while ostra can open a PR per repo; a line in the page body through `PATCH /v1/pages/{id}/markdown` (`update_content` and `replace_content` modes), which edits the member's own text; or a comment. **Recommendation:** a comment with the links, plus a mapped `url` property for the task link when the admin picks one. | [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content) |
| `createTicket` | `POST /v1/pages` with the `data_source_id` parent, the title and status properties, and `markdown` for the body (which "can't be combined with `children`"). Needs `insert_content`. A body over 5,000 blocks is refused. | [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content), [upgrade guide](https://developers.notion.com/docs/upgrade-guide-2025-09-03) |
| `updateTicket` | `PATCH /v1/pages/{id}/markdown` with `replace_content`. It refuses to delete child pages unless `allow_deleting_content` is true, and ostra leaves that false. | [Markdown guide](https://developers.notion.com/guides/data-apis/working-with-markdown-content) |
| `attachFile` | Upload with the File Upload API (direct up to 20 MB, multi-part above it), then attach the upload to a mapped `files` property or to a file block. "Free workspaces are limited to 5 MiB … per file", and paid ones to 5 GiB. The limit is readable at `bot.workspace_limits.max_file_upload_size_in_bytes`. There's nowhere natural to keep ostra's marker, so `attachments: false` at first. | [Files and media](https://developers.notion.com/docs/working-with-files-and-media), [file object](https://developers.notion.com/reference/file-object) |
| `detectCodeHostIntegration` | Not researched. Answer `installed: false`. | — |

### 2.7 Rate limits and pagination

Source: [Request limits](https://developers.notion.com/reference/request-limits), unless noted.

- **Per connection:** 600 requests a minute on Business and Enterprise workspaces, and **180 a minute** (about 3 a second) on every other plan. The budget can be spent in one burst within the minute.
- **Data-source queries:** about 3 a second per connection, counted separately.
- **Per workspace:** there's also a workspace-wide limit across all its connections, with no figure given.
- **Over the limit:** 429 `rate_limited`, with a `Retry-After` in seconds (at most 60 for a per-connection overage). A 529 `service_overload` is retried the same way.
- **Size limits:** 2,000 characters per rich-text `text.content`, 100 elements per array, 1,000 block elements and 500 KB per payload, and 100 options per multi-select. Over a limit is a 400 `validation_error`. A long comment written as `rich_text` is split into several text objects. Whether the `markdown` parameter is held to the same limits is **unverified**.
- **Pagination:** `page_size` 1–100 (default 100), `start_cursor` and `next_cursor`, and `has_more`. "A page can contain fewer items than `page_size` even when more remain." Queries and search take these in the POST body ([pagination](https://developers.notion.com/reference/pagination)).
- **The cost per ticket:** about four calls (the page, its Markdown, its comments, and a property or two), so 180 a minute is about 45 ticket reads a minute before polling and writes. The adapter's rate budget (ADR 0025's plumbing) has to be tuned for it, and progress comments coalesced, as for Jira.

### 2.8 Verdict: Notion

**Effort (recommendation): medium to large, about Jira's or more.**
- **What helps:**
  - first-party Markdown for page bodies and comments, so no ADF-style converter;
  - a direct status write;
  - stable property IDs.
- **What costs:**
  - a property-mapping step at connect time, which no other tracker needs (Jira and Linear map statuses only);
  - a webhook that's created by hand and verified by pasting a token back;
  - at-most-once delivery, so the poller carries correctness;
  - tight limits;
  - comments that can't hold lists or code blocks;
  - files whose URLs expire;
  - a board that's a data source inside a database.

**Capabilities:**

| Capability | Value |
|---|---|
| `agentSessions` | `false` |
| `subIssues` | `false` at first (`true` once a self-relation can be mapped) |
| `statusGraph` | `false` |
| `webhooks` | `true` |
| `commentEdit` | `true` |
| `attachments` | `false` at first |
| `transitions` | `false` |
| `mentions` | `true` |
| `agentScopes` | `[]` |
| `agentSessionLink` | `false` |
| `ticketFields.acceptanceCriteria` | `false` |
| `ticketFiles` | `"all"` |

**The admin's connect flow:**
1. A workspace owner opens Notion's Developer portal and creates an internal connection named ostra. They turn on read, update and insert content, read and insert comments, and user information with email addresses.
2. They copy the token into ostra.
3. In Notion, on the tickets database, they choose ••• → Add connections → ostra.
4. In ostra, they paste the database's URL. ostra lists its data sources, the admin picks one, and ostra shows the properties.
5. The admin maps the status property (and each of its options to a category and to the started, in-review and done steps), and optionally the assignee, labels, key, parent and link properties.
6. Optional, with a public HTTPS URL:
   - In the connection's Webhooks tab, create a subscription to ostra's URL, with `page.created`, `page.properties_updated`, `page.content_updated`, `comment.created`, `comment.updated` and `data_source.schema_updated`.
   - ostra shows the verification token it received, and the admin pastes it into "Verify subscription".
   - Without this step, ostra polls.

**The awkward parts:**
- every database's schema is different;
- the board is a data source;
- the webhook handshake is manual;
- delivery is at-most-once and out of order;
- 180 requests a minute;
- comments with inline Markdown only, and resolved ones invisible;
- block comments need a call per block;
- no link attachments;
- expiring file URLs;
- `cancelled` has no status group;
- page access is granted per page.

**Recommendation:** feasible, but not soon. Build it after Jira and Trello, only on demand, and spike it first (§3).

---

## 3. Unknowns and things to spike

1. **Trello file downloads.** Does the `/download/` route redirect to signed storage? And how does a bearer token download? This settles whether `downloadFile`'s "no redirect" rule needs a credential-free hop.
2. **Trello's list moves in webhook data.** Confirm the fields of `updateCard` (`listBefore`/`listAfter`, `old.idList`) and the board-actions route and filters for polling.
3. **Trello's terms and seats.** Do the Developer Terms say anything about a self-hosted tool holding a token? Does a bot member cost a seat on a paid Workspace? Does creating an app need a Workspace?
4. **Notion webhooks on an internal connection.** Do they exist? Does a connection get events only for pages shared with it?
5. **Notion's verification handshake in ostra's webhook route.** A pending-subscription state that accepts one unsigned POST per connection. This is a security review item: it must accept the token only while the admin is setting the connection up.
6. **Notion Markdown fidelity.** How mentions, images (the expiry of their URLs inside the Markdown) and `<unknown>` blocks read in a ticket prompt. And whether `last_edited_time` is rounded.
7. **Notion sub-items.** Confirm that the sub-items feature is a self-relation the API exposes, before `subIssues` is declared.
8. **Notion at 180 requests a minute** against a realistic board: intake, the reconcile poll and progress comments together.

---

## Sources

Every source was read on 2026-11-23.

**Trello**
- [Trello REST API: Authorization](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/)
- [Trello REST API: Webhooks](https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/)
- [Trello REST API: Rate limits](https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/)
- [Trello REST API: API introduction](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/)
- [Trello REST API: Action types](https://developer.atlassian.com/cloud/trello/guides/rest-api/action-types/)
- [Trello REST API: OAuth 2.0 client configuration](https://developer.atlassian.com/cloud/trello/guides/rest-api/oauth-2-client-configuration/) (page last updated 2026-10-01)
- [Trello REST reference: Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/)
- [Trello developer changelog](https://developer.atlassian.com/cloud/trello/changelog/)
- [Atlassian forum: "OAuth 2.0 3LO is now available for Trello"](https://community.developer.atlassian.com/t/oauth-2-0-3lo-is-now-available-for-trello/102691) (posted 2026-09-15, speaking for Atlassian)
- [Atlassian forum, Trello Announcements: "Update: Authenticated Access to S3"](https://community.developer.atlassian.com/t/update-authenticated-access-to-s3/43681) (posted 2020-12-09)
- [Atlassian forum: "New Download URL for attachments"](https://community.developer.atlassian.com/t/new-download-url-for-attachments/51012) (2021, user thread, no staff reply: only background, nothing above rests on it alone)

**Notion**
- [Authorization](https://developers.notion.com/docs/authorization)
- [Capabilities](https://developers.notion.com/reference/capabilities)
- [Webhooks](https://developers.notion.com/reference/webhooks)
- [Webhooks: event types and delivery](https://developers.notion.com/reference/webhooks-events-delivery)
- [Upgrade guide 2025-09-03 (data sources)](https://developers.notion.com/docs/upgrade-guide-2025-09-03)
- [Property object (data source properties)](https://developers.notion.com/reference/property-object)
- [Query a data source](https://developers.notion.com/reference/query-a-data-source)
- [Working with comments](https://developers.notion.com/docs/working-with-comments)
- [Working with markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content)
- [File object](https://developers.notion.com/reference/file-object)
- [Working with files and media](https://developers.notion.com/docs/working-with-files-and-media)
- [Request limits](https://developers.notion.com/reference/request-limits)
- [Pagination](https://developers.notion.com/reference/pagination)
- [Intro](https://developers.notion.com/reference/intro)

**ostra**
- `packages/adapter-sdk/src/tracker/base.ts`, `packages/adapter-sdk/src/tracker/capabilities.ts`
- `packages/adapters/adapter-linear/src/linear-adapter.ts`, `packages/adapter-sdk/src/testing/jira-fake.ts` (the capability columns)
- ADR 0013, ADR 0047, `context/research/trackers.md`
