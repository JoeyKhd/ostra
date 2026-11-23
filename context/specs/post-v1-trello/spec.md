# Trello as a tracker (after v1)

**Status:** spec, 2026-11-23. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Feature:** F-153 (Trello), the next tracker after Jira. `context/build-order.md` puts Trello "right after" v1, when someone asks; this spec makes it buildable then. It doesn't move into v1.
**Decisions it builds on:** ADR 0013 (trackers as adapters), 0025 (every integration is an adapter that passes its kind's contract suite), 0026 and 0053 (organizations, isolation), 0030 (no credential in the box), 0035 and 0037 (the event log, the durable queue), 0043 (blobs), 0057 (starting from a tracker), 0070 (a ticket's files), 0071 (several tracker connections per organization, one per site, paused boards, several kinds in the picker). **New for this spec:** ADR 0072 (Trello's app key and bot-member token, its webhooks and its lists as statuses).
**Research it rests on:** `research/trello-and-notion.md` §1, read on 2026-11-23 from Atlassian's Trello developer docs, changelog and developer-forum announcements. Every Trello fact below names the research section that cites the primary source; the primary links are repeated where a decision rests on them.
**Builds on milestone 11** as it was built, not only as it was specified (`specs/m11-trackers-jira/`): the Trackers page and picker, a connection's page, boards from any connection, the per-board mapping, the ticket cache, the webhook inbox's claim-then-200, the poller and its drift backstop. Where the code differs from the m11 spec, this spec follows the code.

Terms follow `context/GLOSSARY.md`. **Bot member**, **Trello board prefix** and **card list** are new; tickets 04 and 08 add them. Lifecycles follow `context/domain-model.md`: Trello's connection uses m11's (`pending` → `active` ⇄ `failed` → `revoked`), and a board uses m11's `attached | paused | detached`.

---

## 1. What this feature ends with

An organization connects a client's Trello account on Trackers, picks the boards its projects work from, and its cards become tickets ostra can start, move, comment on and sync — as a Linear or Jira ticket is.

In more words. Organization › Trackers lists the Linear and Jira connections it has, and now a Trello one: the client's bot member, its name, its boards, how its events arrive. "Connect a tracker" offers Trello beside Linear and Jira; Notion alone stays "Coming soon". Trello connects in two steps: the organization's own Trello app (an API key and its secret) and a dedicated **bot member**'s token, which never expires, authorized on Trello's consent page or pasted by hand, and read back (the member, and the boards it can see) before it's saved. The connection's page reads: its events, its token's state, Replace the token, Replace the app secret, Re-register webhooks, Check again, Rename, Disconnect. A project's Boards attach a Trello board beside its Linear teams and Jira projects; the board's lists are its statuses, and the admin maps each list to a category and ostra's started, in-review and done steps, and gives the board its key prefix (`TR`). Cards arrive in the Inbox as `TR-12`, start tasks, move by their list, take ostra's progress comment and its link to the task and the PR, and sync as a Linear ticket does. ostra registers the webhook on each attached board itself; the delivery is signed with the app secret over the body and the callback URL, and the route answers Trello's `HEAD` check. Without a public address it polls.

### What milestone 11 leaves that this starts from

Read from the code on `main` on 2026-11-23 (`9f1f76bb`), so builders don't rebuild what exists:

- **One interface for every tracker.** `TrackerAdapter` (`packages/adapter-sdk/src/tracker/base.ts`) has every operation a card needs: `listBoards`, `listStatuses`, `getTicket`, `listTickets`, `getTicketContext`, `updateStatus`, `moveTicket(board, ref, target, mapping)` (Linear sets the status), `comment`, `updateComment`, `linkPullRequest`, `linkTask`, `createTicket`, `updateTicket`, `attachFile`, `listAttachments`, `downloadFile`, `filesInText`, `verifyWebhook`/`parseWebhook`, and `health`. `BoardRef` is `{ externalId }`. `TrackerWebhookRequest` is `{ rawBody, headers, secret, now }`.
- **`TrackerCapabilities`** (`capabilities.ts`) declares `agentSessions`, `subIssues`, `statusGraph`, `webhooks`, `commentEdit`, `attachments`, `transitions`, `mentions`, `agentScopes`, `agentSessionLink`, `ticketFields`, `ticketFiles`, `magicWords`, `richText` and `jqlFilter`.
- **The domain holds tracker connections of any kind.** `trackerKinds = ["linear", "jira"]` and `comingSoonTrackerKinds = ["trello", "notion"]` (`packages/domain/src/use-cases/tracker-connections.ts`); a `TrackerConnection` view is a union on kind; `TrackerKindCapabilities` is injected by the API and core (`LINEAR_CAPABILITIES`, `JIRA_CAPABILITIES`). `resumeBoardsInTx` moves a revoked connection's paused boards when the same site connects again. `boardMappingSchema` (`tickets/board-mapping.ts`) holds `open`, `started`, `inReview`, `done`, `ready`, `doneBy` and `magicWord` in `Board.statusMap`; `Board.key` holds a team's key (`OST`), `Board.externalId` the team or project.
- **Core** builds one adapter per connection from its token in the secret store (`tracker/connections.ts`, `buildTracker`), verifies a delivery with the connection's secret through `verifyOnlyTrackers`, claims `(connectionId, deliveryId)` and answers 200 before work (`webhooks/inbox.ts`), polls attached boards every `OSTRA_TRACKER_POLL_SECONDS` (60) with a 5-minute drift backstop, and appends each poll's overlap to the board's cursor.
- **The panel** draws the trackers' marks, including Trello's, and the picker's Trello tile is a disabled "Coming soon" (`components/trackers/tracker-mark.tsx`, `tracker-picker.tsx`, `tracker-words.ts`). The Boards page groups the attach picker by connection; the mapping editor edits the m11 mapping.
- **The settings:** `OSTRA_TRACKER_POLL_SECONDS` (60), `OSTRA_CORE_PUBLIC_URL` (webhooks or polling), `OSTRA_JIRA_API_URL` (the pattern for a fake).
- **The launch gate is held:** milestone 7's held tickets and the demos of milestones 8 to 11 wait for the maintainer's word. This feature's own demo is its ticket 09, run when it's built.

### What is in, and what is not

**In:**
- Trello as a tracker kind: a connection per bot member, named, with its own app key, secret and token; one per bot member in the organization, isolation from the other connections;
- the two connect steps and their read-back; the consent page (`scope=read,write`, `expiration=never`) or a pasted token; polling when the install has no public address;
- a connection's page: events, token state, Replace the token, Replace the app secret, Re-register webhooks, Check again, Rename, Disconnect (which deletes ostra's webhooks and revokes the token at Trello);
- boards as boards: the bot's open boards; the attach picker; a board's lists mapped to categories and to the started, in-review and done steps; the board's key prefix and `TR-12` keys; paused boards on a disconnect and resume on a reconnect;
- cards as tickets: name, Markdown description, checklists appended to the description, comments, labels, members (the first is the assignee), attachments, uploaded files, a direct write to move them, no transitions, no sub-issues, no mentions, no priority;
- ostra registering one webhook per attached board, deleting it on detach and disconnect, and re-registering it when the public address changes; HMAC-SHA1 verification over the body and the callback URL; `HEAD` handled;
- the fake Trello and the tracker contract suite's Trello subject;
- every flow Linear has outside agent mode on a Trello board: the Inbox, intake rules, schedules, Create ticket, prompt tickets, reopen, ticket sync, notifications and the ticket's context and files;
- the docs: a Trello page under Trackers, the configuration reference's two settings, the limitations list.

**Not in:**
- Trello's OAuth 2.0 3LO (announced 2026-09-15). It acts as a signed-in user, needs a client secret and rotating refresh tokens, and Atlassian's own advice for an app that "runs without a logged-in user" is API tokens, which "are not going away" and have "no deprecation timeline" (`research/trello-and-notion.md` §1.2). Revisit only if Atlassian sets a date for tokens.
- Trello's OAuth 1.0.
- A Trello member's email, and therefore mentions (`findUsersByEmail`): a token reads only the granting member's email (§1.6). `mentions: false`.
- Checklists as sub-issues: a checklist item isn't a card and a converted card isn't linked as its child (§1.4). `subIssues: false`; the items go into the ticket's description.
- Attachments uploaded as ostra's own card cover, `setCover`, or image previews.
- Trello's GitHub Power-Up: `detectCodeHostIntegration` answers not installed, as Jira's does, and Done is moved by ostra (§1.6).
- Trello's Enterprise, custom fields, card templates, card links and Workspace-level events.
- Two connections to one bot member: refused, as two connections to one Jira site are (ADR 0071).
- A token that ostra makes by itself without a person pressing Allow or pasting it: Trello's token is a member's grant (§1.2).
- Trello as an agent-session tracker (no agent mode, no `agentSessions`).
- Notion, which stays "Coming soon" behind its spike.

### On this machine

The same adjustment as milestones 1 to 11: the scripted demo runs on the `host` executor against the HTTP fake Trello. What needs more than that:
- **A real Trello account for tests**: an account, an app on `trello.com/apps/admin`, a dedicated bot member added to two test boards with lists, cards and an attachment, and a public HTTPS address for deliveries (the tunnel milestone 2 uses for Linear). The maintainer creates them (ticket 10).
- **The unverified vendor details** (section 11) are settled by that account: a download's redirect, the board-cards paging parameters, the payload's field names, the description's size limit and an upload's size limit.
- **People:** the maintainer's Trello test account and the bot member's Allow (ticket 10).

---

## 2. The feature, and where it lives

| F-ID | What this spec builds | Packages | Tickets | At the end |
|---|---|---|---|---|
| F-153 Trello | The `trello` kind and its columns; `adapter-trello` (client, key+token auth, boards, lists, cards, keys, webhooks, attachments, files, polling); the HTTP fake Trello and the contract suite's subject; the two connect steps, the read-back and the connection's changes; the webhook route, registration lifecycle, polling and sync; the API; the panel; the docs; the demo | `packages/db`, `adapter-sdk`, `packages/adapters/adapter-trello` (new), `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `apps/docs`, `e2e/post-v1-trello` (new) | 01 to 09 | `done` once ticket 09's live run passed (c11); otherwise `building` with the fake Trello proved |

**Rows this spec touches without finishing:**
- **F-152 (Trackers)** gains a third kind and an enabled picker tile; its conditions stand, including one connection per site and boards from any connection. No new status.
- **F-007 (boards)** attaches a Trello board; the mapping gains a list's category and the board's key prefix. No new status.
- **F-042 (private installs)** covers Trello by polling. No new status.
- **F-097 (prompt tasks)** and **F-149 (ticket files)** work on a Trello board as on the others; their conditions already name the tracker interface. No new status.
- **F-005 and F-008** are untouched.

### 2.1 F-153's ledger row, for the orchestrator

The row isn't in `context/features.md` yet. The orchestrator adds this line (the spec must not edit the shared file), and ticket 09 sets its status:

```
| F-153 | Trello | An organization admin connects Trello from Trackers in two steps: the organization's own Trello app's key and secret, whose key Trello's consent page proves, and a dedicated bot member's never-expiring token, authorized on that page or pasted and read back, as the member and the boards it can see, before it's saved. Every call carries the connection's key and token from the secret store, which never reach a box, a log line or a member, and a revoked token fails the connection as `token-refused`. ostra registers a webhook on each attached board itself when the install has a public HTTPS address, and a delivery is refused unless `X-Trello-Webhook` is the base64 HMAC-SHA1, under the app secret, of the raw body followed by the callback URL exactly as registered; the route answers Trello's `HEAD` check and a delivery is stored once per `action.id` and answered at once. Without a public address it polls the board, and the Inbox shows a change within 60 seconds. A board's lists are its statuses: the admin maps every list to a category and maps the started, in-review and done steps, and sets the board's key prefix, so a ticket's key is `TR-12` and its stable card ID never changes when it moves; a move writes the card's list directly, with no transition graph, and Done is moved by ostra. A card reads as a Linear ticket does: its Markdown name and description, checklist items appended to the description, comments, labels, members (the first is the assignee) and attachments, with sub-issues, mentions, priority and linked tickets absent, and its uploaded attachments are its files (F-149), each fetched with the key and token that go only to `api.trello.com` and at most one redirect to storage without them. ostra links the task and the PR as link attachments once per URL and edits its own comment in place. Every flow Linear has outside agent mode works on a Trello board: the Inbox, intake rules, schedules, Create ticket, prompt tickets, reopen, ticket sync, notifications and the ticket's context. The tracker contract suite passes for `adapter-trello` against the fake Trello, with the capabilities it declares (no agent sessions, no transitions, no sub-issues, no mentions). The picker offers Trello beside Linear and Jira, enabled, with its connect steps, the connection's settings, a board's list mapping and key prefix, Trello's mark wherever a ticket shows, and a disconnected board paused and resumed on reconnect. The live run on the maintainer's Trello test account takes a card to a merged PR. | later | planned |
```

The eleven sentences are c1 to c11, in order; section 9.1 says which ticket proves each.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 09:
- **Organization-scoped data:** one new nullable column on `Connection` (an organization-scoped table) and enum values; no new table. Milestone 4's isolation test stays green, and ticket 04 adds a Trello connection to its second organization.
- **The event log and the durable queue:** a delivery is claimed then answered; activation, resume and disconnect are one transaction each; every poll, read-back and re-registration is a job.
- **No credential in the agent's box:** the key, secret and token stay in core and the API; a card's files reach the box as blobs (milestone 9).
- **One adapter, one contract suite:** `adapter-trello` extends `TrackerAdapter` and passes the suite.
- **Strict typing, dark first, responsive, English in message files,** and milestone 7's keyboard walk and contrast check on the new screens.

---

## 3. The end-to-end demo

Ticket 09 runs it when the feature is built, and records the result under its `## Comments` and in `demo.md` next to this spec. Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/trello.env; set +a`, and are never printed, logged or committed.

**Two runs.** The scripted run (`pnpm e2e:trello`, `e2e/post-v1-trello/`) runs every step without a person, on the `host` executor, against the HTTP fake Trello at `OSTRA_TRELLO_API_URL` and the fake Linear at `OSTRA_LINEAR_API_URL`, with two fake bot members. The manual run, once, in a real browser, connects the maintainer's real Trello test account through the tunnel and takes a real card to a merged PR.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `pnpm dev`, and milestones 1 to 11's helpers: a model provider, the test App on `test1`, a project `test1`, a personal runner on `host`. The panel signs in as `demo@demo.com` / `demo`. Sam joins as an organization member (not an admin).

1. **The picker.** Organization › Trackers opens `Connect a tracker`: Linear, Jira and Trello are enabled tiles; only Notion says `Coming soon` and it isn't focusable. Choosing Trello and `Continue with Trello` makes a pending connection and opens its page.
2. **Step 1, the app.** Demo pastes the app's API key and secret and the connection's name (`Acme Trello`). `Save and continue` stores only the name and the key; the secret goes to the secret store. The page shows the consent link.
3. **Step 2, the member.** The fake's consent page returns a token in the URL fragment (the manual run has the bot member press Allow). The page reads it from the fragment, then `Check the token` shows the member's username, that it's the connection's own bot, and the boards it can see (five open, one closed). `Save and continue` stores the token and the connection turns active, `Connected`, mode `webhooks` (a public URL is set).
4. **The failures.** A token for a member already connected (refused, naming the connection); a token Trello refuses (401, red row, nothing saved); a revoked token later (the connection `failed`, `token-refused`, its boards paused); a name already used (refused).
5. **Polling instead.** With `OSTRA_CORE_PUBLIC_URL` unset, a second Trello connection (`Northwind Trello`, another fake bot) connects with step 2 only and mode `polling`. A card edited on the fake reaches the Inbox within 60 seconds by polling.
6. **A board attaches.** On `test1`'s Boards, the attach picker groups `Acme Trello`'s five boards beside the Linear and Jira ones. Demo attaches `Calculations` and gives the prefix `TR`. The fake records the `HEAD` check, then the webhook creation on that board with ostra's callback URL.
7. **The mapping.** The board's lists read `Backlog`, `To Do`, `Doing`, `Review`, `Done`, `Won't do`. Demo maps each to a category, `To Do` as started, `Review` as in review, `Done` as done, and leaves `Won't do` cancelled. `Save` drafts and stores the mapping and the categories.
8. **A card becomes a task.** The Inbox lists `TR-12` with Trello's mark. Demo starts it. The first message's "What the agent got" holds the description (Markdown), a checklist appended under `Checklists`, the comments, the labels and the members, and the card's files (an uploaded screenshot and a `.docx`), each fetched with the key and token. The card moves to `Doing`; ostra's progress comment appears; the task's link is an attachment on the card.
9. **The PR and Done.** The agent opens a PR whose branch and title carry `TR-12`, and ostra adds the PR's link attachment once. The card moves to `Review`. The PR merges: ostra moves the card to `Done`.
10. **A card with no route.** A card already in `Won't do` gets its task and its PR: the mapping moves it to done like any other, because a list write always works. The task page's "On Trello" rows say the list each move wrote.
11. **Echoes and duplicates.** Every delivery of ostra's own writes (the bot member's `memberCreator`) is stored and not acted on. The run replays one delivery five times: one row, one action. A delivery with a wrong signature is refused, counted, and leaves the connection connected.
12. **The secret and the address.** Demo replaces the app secret: the next delivery signed with the old one is refused, one with the new one is accepted. Demo changes `OSTRA_CORE_PUBLIC_URL` and presses `Re-register webhooks`: the old callback URL gets no more deliveries and the new one does.
13. **Detach and disconnect.** Detaching the board deletes its webhook on the fake. Disconnecting the connection deletes the remaining webhooks, revokes the token at the fake, deletes the secrets, and pauses its other board with its pause line and `Trackers →`. Connecting the same bot again resumes the paused board with its mapping and categories; the fake sees a new webhook on the new connection.
14. **Linear and Jira unchanged.** A Linear ticket and a Jira issue run end to end as their demos did.

**The checks after the run** (ticket 09 scripts what it can, in `e2e/post-v1-trello/`):
- **Nothing leaked.** No key, secret, token, card text or comment body appears in any log line, event's log field, URL ostra built or panel response to a member (searched by value, never printed).
- **Kept apart.** Every call of the run went to its own connection's credential digest and bot member; the fake records both, and no request of one connection carries another's.
- **Parity.** The tracker contract suite passes for Linear, the in-memory Jira fake, `adapter-jira` against the fake Jira, `adapter-trello` against the fake Trello, and the tiny adapter.
- **Clean-up:** the demo's cards archived, its PRs closed and branches deleted, in `test1` only.

---

## 4. How it fits together

```
 browser ──▶ apps/web: Trackers (Trello enabled in the picker), /organization/trackers/<id>
   │                    (Trello's two steps, the settings), Boards (attach, list mapping, prefix),
   │                    the ticket chips and the task's "On Trello"
   │     └─ tRPC: trackers.create({kind:"trello"}), trackers.trello.saveApp / authorizeUrl /
   │              checkToken / saveToken / replaceToken / replaceAppSecret / recheck /
   │              reregisterWebhooks, trackers.rename / disconnect,
   │              boards.attachable / attach(keyPrefix) / mapping(statusCategories) / get
 api ──▶ the Trello connect kit (adapter-trello): /1/members/me, /1/members/me/boards,
   │       with the key and token being checked, never stored before a pass
 Trello ─webhook─▶ core HEAD /webhooks/trello/<connectionId> → 200 (Trello's creation check)
   │                POST: X-Trello-Webhook over body + callback URL, under the app secret →
   │                claim action.id → 200 → job: fetch the card, ingest
 core ──poll──▶ /1/boards/<id>/cards (updated at or after the cursor) and the card's actions,
   │             per board, every 60 s in polling mode, every 5 min as a backstop
 core ──▶ the tracker (adapter, per connection, its own key+token): a move writes idList,
   │       comments and comment edits, link attachments once per URL, uploads, downloads
 core ──▶ Postgres: connections (kind trello, named, per bot member), boards per connection,
   │       paused when not active
```

**The flows:**
- **Connecting Trello** (tickets 04, 06, 08). `trackers.create({ kind: "trello", name })` makes a `pending` row with `appId` `pending:<id>` and audits `tracker.connection-created`. `saveApp` stores the key (not a secret) and the secret (secret store, `purpose: "trello-app-secret"`). `authorizeUrl` builds `https://trello.com/1/authorize?key=…&scope=read,write&expiration=never&response_type=token&callback_method=fragment&return_url=…` with the key from the row (admins only); the panel's callback page reads `#token=` and never logs it. `checkToken` calls `GET /1/members/me` and `GET /1/members/me/boards` with the pasted token, in memory, and answers the member line and the boards line. `saveToken` runs the check again, refuses a failure or a member another connection holds, stores the token, the member's ID and username, sets the row `active` with `credentialKind: "trello_token"`, and audits `tracker.connected`; the same transaction resumes the paused boards of a revoked Trello connection of the same member (ADR 0071).
- **An event** (ticket 05). `HEAD /webhooks/trello/<id>` answers 200 for a connection not revoked (Trello's creation check). `POST` reads the raw body, finds the connection (revoked: 410, unknown: 404), computes the callback URL from `OSTRA_CORE_PUBLIC_URL`, verifies `X-Trello-Webhook`, claims `(connectionId, action.id)`, answers 200, then enqueues the same processing job as Linear's: `parseWebhook` gives the hint, the bot member's own writes are recorded and skipped, and the job fetches the card before ingesting it.
- **Polling** (ticket 05). `listTickets` reads the board's cards with `dateLastActivity` at or after the cursor, oldest first, and pages by its own cursor; because label changes and comment edits aren't actions a poller sees (§1.3), the card's fields are the reconcile, and the next context read sees a comment's current text. The 5-minute backstop sets `webhooksSilentSince` when it finds changes the webhooks didn't bring.
- **A move** (ticket 05). Ticket sync's planned move calls `moveTicket(board, ref, target, mapping)`; Trello's adapter writes `idList` to the mapping's status for the target, in one `PUT /1/cards/{id}`, and answers `moved` with `via: []`. Already there: `moved: false`, nothing written. A list always accepts a card, so there's no unreachable status and no route.
- **Registration** (tickets 02, 05). When a board of an active Trello connection is attached, and on `Re-register webhooks`, core calls the adapter's `ensureBoardWebhook(board, callbackUrl)`; the adapter lists the token's webhooks and creates one (`idModel` the board, `description` ostra's marker) only when none matches the callback URL; Trello's `HEAD` check must answer 200. On detach and disconnect, `removeBoardWebhook(board, callbackUrl)` finds it by the callback URL and deletes it. Nothing about the registration is stored in a column: the callback URL is derived, and the list route is the lookup.
- **Disconnecting** (ticket 04). `trackers.disconnect` deletes the connection's webhooks (one per attached board), revokes the token at Trello (`DELETE /1/tokens`), deletes the app secret and the token from the secret store, ends nothing (Trello has no agent sessions), and sets the row `revoked` with `appId` given back. Its boards pause by derivation (m11); a reconnect resumes them.

---

## 5. The contracts

Every contract change is **additive**: an optional field, a new capability, a new method with a base answer, a new enum value, a new nullable column, a new optional key in a JSON mapping. None drops a constraint or a column. Each lands as one small commit that names the contract and updates every caller in the same commit.

### 5.1 `packages/db`: the Trello migration (ticket 01)

One new migration after the latest on `main`, named `<timestamp>_trello`.

| Change | What |
|---|---|
| `ConnectionKind` | + `trello` |
| `ConnectionCredential` | + `trello_token` (the bot member's never-expiring token) |
| `Connection` | + `apiKey` (String, null): Trello's app key. Not a secret: it travels in the consent URL and every API call. The app's **secret** is `webhookSecretSecretRef` (the app secret's only job is signing deliveries, and the inbox already reads that ref), and the token is `accessTokenSecretRef` |
| Trello's use of the existing columns | `appId` the bot member's Trello ID (`pending:<id>` before step 2); `externalWorkspaceId` the same member ID; `externalWorkspaceKey` its username; `externalWorkspaceName` its full name; `appUserId`/`appUserName` the same member (the echo filter); `name` the admin's name; `state`, `webhookMode`, `lastEventAt`, `webhooksSilentSince`, `activatedAt`, `failedReason`, `createdByMemberId`, `accessCheckedAt` as the kind's lifecycle uses them |

**No data is copied and no row is rewritten.** The migration adds an enum value and a nullable column. Its test (`packages/db`) runs it over a milestone 11 database with Linear and Jira connections, two boards and cached tickets, and checks every row reads back unchanged, the two new enum values insert, `apiKey` starts null, the isolation test still passes, and `pnpm db:migrate` on a copy of the previous migration set is clean. `tokenExpiresOn`, `accessCheck`, `accountEmail` and `firstDeliveryAt` stay Jira's and are `null` on a Trello row; the connection's view never draws a token date for Trello, because the token doesn't expire.

**No change to `Board`.** A Trello board's prefix lives in the existing `Board.key`, and its per-list categories in the existing `Board.statusMap` JSON (section 5.4). No new column, and an older mapping without them parses (they're optional).

### 5.2 `packages/adapter-sdk`: the callback URL, the registration, and a board's settings (ticket 02)

Implemented by Linear, the in-memory Jira fake, the tiny tracker and, once it exists, `adapter-trello`, in the same commit (adapter parity, `AGENTS.md`).

- **`TrackerWebhookRequest` gains `callbackUrl?: string`:** the callback URL exactly as registered, which a tracker that signs it needs (Trello). The inbox passes the URL it derives from `OSTRA_CORE_PUBLIC_URL` and the connection's kind and ID for every delivery. An adapter that needs it and doesn't get it refuses the delivery as `bad-signature`; the others ignore it. Its doc says the URL is never logged.
- **A new capability `webhookRegistration: boolean`:** the adapter can create and delete its own webhooks on a board. Trello `true`; Linear and Jira `false` (an admin made theirs); the tiny tracker `false`.
- **Two new methods with base answers**, both `unsupported` without the capability:
  - `ensureBoardWebhook(board: BoardRef, callbackUrl: string): Promise<AdapterResult<{ readonly webhookId: string; readonly created: boolean }>>` — lists the credential's webhooks, returns the one whose callback URL and model match (`created: false`), or makes one (`created: true`). Idempotent; the tracker's own creation check (Trello's `HEAD`) is the tracker's business.
  - `removeBoardWebhook(board: BoardRef, callbackUrl: string): Promise<AdapterResult<void>>` — finds it by the callback URL and the board and deletes it; none is `not-found`.
- **`BoardRef` gains two optional settings**, documented as "a tracker whose boards carry settings ostra's admin sets":
  - `keyPrefix?: string`: the prefix the admin gave a board whose tracker numbers tickets per board (Trello's `TR`), so the adapter's `Ticket.key` is `TR-12` and a key lookup parses the prefix. Absent: the tracker's own key.
  - `statusCategories?: Readonly<Record<string, TicketStatusCategory>>`: the admin's category per status, for a tracker whose statuses carry none (Trello's lists). Absent: the adapter's own guess. An adapter applies it wherever it reports a status: `listStatuses`, `getTicket`, `listTickets`, `moveTicket` and `getTicketContext`, so every caller and the cache see the admin's category, and no caller overrides it.
- **The tracker contract suite's fixture gains** `callbackUrl` (the URL its deliveries are signed with), and its board may carry `keyPrefix` and `statusCategories`; the delivery helper signs over the body and that URL.
- **The tracker contract suite gains** (`testing/tracker-suite.ts`, `tracker-workflow-cases.ts`):
  - `F-153/c9`: the suite's webhook case signs with the fixture's callback URL; an adapter that declares `webhookRegistration` creates a webhook on a board once (a second call returns the same ID), removes it, and the next signed delivery is refused after the removal; an adapter without the capability answers `unsupported` from both methods.
  - `F-153/c5`: a board whose `BoardRef` carries a key prefix and categories reports keys as `TR-12`, categories as the admin's, and a move writes the mapping's status; a board without them keeps the tracker's own.
  - `F-153/c6`: the fixture's attachments and uploaded files; a `downloadFile` off the tracker's own host gets no credential; the marker in an attachment's name is read back (the subtitle).
- **The suite's capability checks and the guide:** `tracker-suite.ts`'s `trackerCapabilityTypes` gains `webhookRegistration: "boolean"`, so every subject states it and a subject without it answers `unsupported`; the adapter guide's `tracker-capabilities.ts` sample gains `webhookRegistration: false` and names the two methods, and `adapter-guide-samples.test.ts` holds the sample to compiling (`apps/docs/content/contributing/adapters.mdx`). `testing/tracker-parity.ts`'s table is unchanged: its rows are milestone 11's words, and the capability cases are the parity proof here.

### 5.3 `packages/adapters/adapter-trello` (ticket 03)

A new Apache-2.0 package, `@ostra/adapter-trello`, beside `adapter-linear` and `adapter-jira`: `TrelloAdapter extends TrackerAdapter`, one level deep (ADR 0025), and the connect kit.

- **The client:** a hand-written REST client on `fetch` against `https://api.trello.com/1` (or `OSTRA_TRELLO_API_URL`), with an `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"` header (`research/trello-and-notion.md` §1.2), a timeout per call, Zod schemas at every response that tolerate unknown fields, and errors carrying the status code and Trello's error code (`API_TOKEN_LIMIT_EXCEEDED`, `API_KEY_LIMIT_EXCEEDED`, `API_TOKEN_DB_LIMIT_EXCEEDED`, `API_TOO_MANY_CARDS_REQUESTED`), never Trello's body.
- **Rate budgets:** two per connection, both from `plumbing.rateBudget`, named by a digest of the credential and never the credential: the token's 100 requests per 10 s and the app key's 300 per 10 s, which connections sharing a key share (`§1.7`). `/1/members/` routes keep their own 100 per 900 s budget; nested member routes such as `/1/members/me/boards` don't count against it. On 429 the adapter waits out the remaining window (Trello's own 10 s) and backs off longer after `API_TOKEN_DB_LIMIT_EXCEEDED`; a key that collects 200 429s answers 429 for the rest of its window, so it never retries tightly.
- **Boards and lists:** `listBoards` = `GET /1/members/me/boards?filter=open` (the bot's open boards; `§1.1`), each `{ externalId: board.id, key: "", name }` — a Trello board has no key until the admin gives one. `listStatuses` = the board's lists in `pos` order, each `{ id, name, category: statusCategories?.[id] ?? guess(name), vendorType: "list", position }`; the guess is `done` for `done|complete|shipped|merged|finished`, `cancelled` for `cancel|archive|won't`, `started` for `progress|doing|review|qa|active|started`, else `open`, and the admin confirms or edits every one.
- **Cards as tickets:** `getTicket` by the stable `id`, and by key (`TR-12`: the prefix is `BoardRef.keyPrefix`, `12` is `idShort`) by matching the board's cards; a key whose prefix isn't the board's, or a card on another board, is `not-found`. `listTickets` reads the board's cards with `fields` limited to what a ticket needs, `updatedSince` on `dateLastActivity` (inclusive), oldest first, a page of at most 1,000 *(the API's documented cap for card and action queries, `§1.7`; the board route's own page size is confirmed in ticket 03)*, a cursor of the last card's `dateLastActivity` and ID; `statusIds` filters by `idList` (the adapter reads the board once and filters, so a board's lists are one call). Card name and `desc` (Markdown), `url`/`shortUrl`, `dateLastActivity`; `priority: null`; `assignee` the first of `idMembers` (resolved through the card's expanded `members`), `null` when none; `labels` the board's label names by `idLabels`; `trackerProject` absent; `parentExternalId` null. `status` from `idList`, with the admin's category.
- **Statuses and moves:** `updateStatus` and `moveTicket` write `idList` with `PUT /1/cards/{id}` (`§1.5`); `moveTicket` returns the new status and `via: []`; already there writes nothing. There's no transition graph (`transitions: false`, `statusGraph: false`), so `readWorkflow` is the base's `unsupported`.
- **Comments and links:** `comment` = `POST /1/cards/{id}/actions/comments`, answering the action's ID; `updateComment` = `PUT /1/cards/{id}/actions/{id}Action/comments`, allowed for ostra's own comment; `linkPullRequest` and `linkTask` = a URL attachment (`POST /1/cards/{id}/attachments`) created once per URL by listing the card's attachments first, the `kind` ignored (`magicWords: false`); `detectCodeHostIntegration` answers `installed: false`.
- **A ticket's context:** comments are the card's `commentCard` actions, oldest first, not threaded (`parentId: null`), the author from `memberCreator`; attachments are `GET /1/cards/{id}/attachments`, a link attachment stays a link, an upload (`isUpload: true`) is a file; `TicketAttachment.subtitle` is the attachment's `name`, where ostra's marker lives, and `title` is the name with the marker stripped; checklists (`GET /1/cards/{id}/checklists`) are appended to the description as a `## Checklists` section with `- [x]`/`- [ ]` items, because they aren't cards or sub-issues (`§1.4`); `parent`, `children` and `linked` are empty; `files` are the uploads (and a Markdown link to one of the card's own attachment URLs, which `filesInText` recognizes) and never a link to another site; `images` are the image uploads.
- **Files and downloads:** `attachFile` uploads (`POST /1/cards/{id}/attachments`, multipart `file`, `name`, `mimeType`) with ostra's marker in the `name`; `listAttachments` reads the name back; `downloadFile` requests the attachment's download route with the key and token **only to `api.trello.com`**, reads at most `maxBytes`, and, if the answer is a 302 to the tracker's storage, follows **exactly that one hop without the header** (the contract's sentence is amended in the same ticket; section 11 records what's unverified). Off the tracker's host nothing is fetched.
- **Webhooks:** `verifyWebhook` checks `X-Trello-Webhook` as the base64 HMAC-SHA1 of the raw body followed by `request.callbackUrl` exactly as registered, keyed with the app secret, compared constant-time (`§1.3`); the delivery ID is `action.id`, `sentAt` is `action.date` when the body has one; the freshness window is 30 minutes *(working value)*, since Trello's retries come 30, 60 and 120 s later and it sends no timestamp header. `parseWebhook` reads the card and comment actions (`createCard`, `updateCard`, `deleteCard`, `commentCard`, `updateComment`, `deleteComment`, `addAttachmentToCard`, `deleteAttachmentFromCard`, `addMemberToCard`, `addLabelToCard`, the list actions) into a hint: the subject, the action, the card's ID, the board's ID from `model.id`, and `byOwnUser` when `action.memberCreator.id` is the connection's own member. `ensureBoardWebhook`/`removeBoardWebhook` use `POST`/`GET`/`DELETE` on `/1/tokens/{token}/webhooks` and `/1/webhooks/{id}` (`§1.3`), match by `callbackURL` and `idModel`, and set `description` to ostra's own marker so a person can tell them apart.
- **A webhook Trello disables:** Trello disables a webhook after failures that last 30 days and number over 1,000, both at once (`§1.3`); the adapter gets no notice, so the 5-minute drift backstop's `webhooksSilentSince` is how the panel shows it, and `Re-register webhooks` makes a new one. The docs say so (ticket 08).
- **Tickets made and updated:** `createTicket` (`POST /1/cards`) puts the card in the board's first list whose category is `open`, else its first list; `updateTicket` writes `desc` and answers `invalid-input` for `acceptanceCriteria` (Trello has no such field, so core writes the criteria into the description); `getUser` reads a member by ID; `findUsersByEmail` stays the base's `unsupported` (`mentions: false`).
- **The declared capabilities:** `agentSessions: false`, `agentScopes: []`, `agentSessionLink: false`, `subIssues: false`, `statusGraph: false`, `webhooks: true`, `commentEdit: true`, `attachments: true`, `transitions: false`, `mentions: false`, `ticketFields: { acceptanceCriteria: false }`, `ticketFiles: "all"`, `magicWords: false`, `richText: "markdown"`, `jqlFilter: false`, and section 5.2's `webhookRegistration: true`.
- **The connect kit** (`connect.ts`), exported as `trelloConnect`, each call taking `{ apiUrl, fetch, timeoutMs }` and answering `adapter-trello`'s own result types, as `jiraConnect` does:
  - `checkToken({ apiKey, token })` → `{ member: { id, username, fullName }, boards: readonly { id, name, closed }[], boardsCount }`, from `GET /1/members/me` and `GET /1/members/me/boards`; a 401 is `refused`;
  - `authorizeUrl({ apiKey, returnUrl, authorizeUrl })` → the consent URL of section 4;
  - `revokeToken({ apiKey, token })` → `DELETE /1/tokens` (the token itself names the member) for a disconnect, best effort.
  - `listBoards` and `registerWebhook` are the adapter's, not the kit's, because core calls them through the interface.
- **The fake Trello** (`packages/adapter-sdk/src/testing/fake-trello/`, in `fake-jira`'s house style): an HTTP fake with the routes the adapter and the kit call, key+token auth and Trello's 401, two bot members and their boards, lists with `pos`, cards with `idShort`, labels, members, actions, comments, checklists, attachments (uploads and links), the attachment download route with an optional 302 to a fake storage that requires no credential, webhook creation with a real `HEAD` check, signed deliveries on demand (and wrongly signed ones), a 429 with the rate-limit headers, and a record of each request's bot member, credential digest and host. The suite fixture drives it the way people do outside ostra.

### 5.4 `packages/domain` (ticket 04)

- **The kinds:** `trackerKinds` gains `"trello"`; `comingSoonTrackerKinds` becomes `["notion"]`; `isTrackerKind`, `trackerKindNames` (`Trello`) and the `TrackerConnection` union gain Trello's arm: `{ kind: "trello", name, site: username, botName: fullName, botUserName: username, tokenState, boardsCount, capabilities }`, no token date. `TrackerKindCapabilities` gains `trello: TRELLO_CAPABILITIES` at the API's composition root.
- **Names and one per bot member:** the name is the admin's, prefilled `Trello` (`defaultConnectionName("trello", null)`; the admin types the client's); `siteTakenBy(db, org, "trello", memberId)` refuses a second connection of the same bot member, naming the holder (the m11 rule, one site per connection).
- **The connect use cases** (`use-cases/trello-connection.ts`), admin only, each a transaction where it writes, each audited:
  - `startTrelloConnection({ name })` → pending, `appId` `pending:<id>`, `tracker.connection-created`;
  - `saveTrelloApp({ connectionId, apiKey, secret, name })` → refuses a blank key or secret (no shape is assumed: Trello's consent page is what proves the key), stores the key and the secret (`purpose: "trello-app-secret"`), audits `tracker.app-saved`; replacing the key clears step 2;
  - `trelloAuthorizeUrlOf({ connectionId, panelOrigin })` → the URL of section 4, using `OSTRA_TRELLO_AUTHORIZE_URL` when set; admins only;
  - `checkTrelloToken({ connectionId, token })` → the kit's check, nothing stored, in memory only; the member, whether another connection holds it, and the boards;
  - `saveTrelloToken({ connectionId, token })` → checks again, refuses on a failure or a member another connection holds, stores the token and the member's IDs and names, sets the row `active` (webhooks when a public address is set, else polling), audits `tracker.connected`, and calls `resumeBoardsInTx` in the same transaction;
  - `replaceTrelloToken`, `recheckTrelloToken` (with the stored token), `replaceTrelloAppSecret` (stores a new secret; deliveries signed with the old one are refused, the next signed with the new one is accepted), `reregisterTrelloWebhooks` (enqueues the job core runs: `ensureBoardWebhook` on each attached board with the current URL), `disconnectTrello` (webhooks deleted, token revoked at Trello, secrets deleted, row revoked, `tracker.disconnected`), `failTrelloConnection(tx, id, "token-refused")` for a 401 on a saved token.
  - `trelloWebhookCallbackUrl({ connectionId })` → `new URL('/webhooks/trello/<id>', OSTRA_CORE_PUBLIC_URL)`, or `null` without one; the one place the URL is built.
- **The board's settings:** `boardMappingSchema` gains `statusCategories: z.record(statusIdSchema, z.enum(ticketStatusCategories)).optional()` — the admin's category per list; `boardRefOf(board)` (`tickets/board-ref.ts`, new) builds the adapter's `BoardRef`: `{ externalId, ...(board.key ? { keyPrefix: board.key } : {}), ...(mapping?.statusCategories ? { statusCategories } : {}) }`, the one place every caller (core's ingest, writer, context, domain's sub-issues, refine, agent mode, the API's board reads) gets a ref. A Trello board's prefix is required and unique among the project's attached boards (`keyPrefixTakenBy`, `key-prefix-taken`); a Trello mapping with a step not on its lists is `unknown-mapped-statuses`.
- **The lifecycle and resume:** m11's, unchanged; a Trello connection's revoked row is resumed by member ID.
- **Words:** the board's "lists" (not "statuses") in the mapping's copy, `keyPrefix`'s `TR` hint, and the paused board's line; the audit actions above.
- **Docs in the same commit:** `domain-model.md` gains Trello's connection's arm (the same lifecycle); `GLOSSARY.md` gains **Bot member**, **Trello board prefix** and **Card list**.

### 5.5 `packages/api` (ticket 06)

- `toApiDeps` and `TRPC`:
  - `trackers.create` takes `kind` `"trello"`;
  - `trackers.trello.saveApp`, `.authorizeUrl`, `.checkToken`, `.saveToken`, `.replaceToken`, `.replaceAppSecret`, `.recheck`, `.reregisterWebhooks`, each admin-only and field-by-field (no key, secret or token in any output; the authorize URL is admin-only because it names the key);
  - `trackers.list`/`get` include the Trello arm; a member reads the name, the bot's username and full name, the state and boards, never the key or the token's detail;
  - `boards.attachable` groups the connection's boards (Trello's `listBoards`, `key: ""`); `boards.attach` takes `keyPrefix` for a Trello board (2 to 8 `[A-Z0-9]`, unique per project) and refuses its absence; `boards.mapping` saves `statusCategories`; `boards.get` returns them;
  - every ticket payload's `tracker.kind` union gains `"trello"`: the Inbox, a ticket's chip, `tasks.get`, notifications and the task's "On Trello" rows (the list's name per move, no transitions).
- The API's `services/ticket-trackers.ts` gains Trello: its `capabilitiesSchema` adds `webhookRegistration`, and the picker's per-kind capability map (which the Trackers page passes to `TrackersView`'s `kinds`) includes `trello` beside `linear` and `jira`. `services/trello-connect.ts` (new) implements the domain's `TrelloConnectKit` port on `adapter-trello`'s connect calls, wired in `runtime.ts`, as `services/jira-connect.ts` does.

### 5.6 Core (ticket 05)

- `buildTracker` gains `"trello"`: `new TrelloAdapter({ apiKey, token, apiUrl? }, context)` from the row's `apiKey` and `accessTokenSecretRef`'s token; `verifyOnlyTrackers` gains a Trello verifier constructed with placeholders (verification is pure: it uses the per-delivery secret and callback URL); `trackerKindCapabilities` gains `trello: TRELLO_CAPABILITIES`.
- `webhooks/inbox.ts`: `WebhookKind` gains `"trello"`; the route `HEAD`/`POST /webhooks/trello/:id`; the callback URL computed once per delivery and passed to `verifyWebhook`; the same claim, 200 and job.
- `webhooks/process.ts`: the `trello` handler: parse the hint, skip the bot member's own writes, fetch the card through the connection's adapter, ingest; a card action that names a list re-reads the statuses when the hint is a list change.
- `tracker/ingest.ts` and the polling set: `boardRefOf` everywhere; the 5-minute backstop and the 60-second poll as they are, for the Trello board too.
- `tracker/registration.ts` (new): `ensureBoardWebhooks(connection, boards)` and `removeBoardWebhooks(connection, boards)`, called when a board attaches or detaches, when a connection activates or is disconnected, and by `Re-register webhooks`; a failure is a job retry and a needs-you item, never a failed activation.
- `tracker/writer.ts`, `context.ts` and `refine/apply.ts`: `boardRefOf`; the move's `via: []` draws the "On Trello" rows with the target list's name; `getTicketContext`'s checklists arrive inside the description.
- `tracker/refresh-token.ts`: untouched (Trello's token doesn't refresh).
- `tracker/token-expiry.ts`: untouched (Trello has no date); a 401 from a saved token goes through `failTrelloConnection`.

### 5.7 Settings

| Setting | Default |
|---|---|
| `OSTRA_TRELLO_API_URL` (server) | empty: `https://api.trello.com`. Set it only to the fake Trello in tests |
| `OSTRA_TRELLO_AUTHORIZE_URL` (server) | empty: `https://trello.com/1/authorize`. Set it only to the fake's consent page in tests and the browser suite |

Nothing else is new: polling reads `OSTRA_TRACKER_POLL_SECONDS`, webhooks or polling follows `OSTRA_CORE_PUBLIC_URL`, and the callback URL changes only with that setting. A fresh install with only the required settings connects Trello by polling, and by webhooks once the address is set. Both settings get their lines in `docs/configuration.md` (ticket 08).

---

## 6. The capabilities row

`TRELLO_CAPABILITIES` (`packages/adapters/adapter-trello/src/trello-adapter.ts`):

| Capability | Value | Why |
|---|---|---|
| `agentSessions` | `false` | Trello has no agent sessions; no agent mode |
| `agentScopes` | `[]` | no agent sessions |
| `agentSessionLink` | `false` | none |
| `subIssues` | `false` | a checklist item isn't a card and a converted card isn't linked (`§1.4`); checklists are in the description |
| `statusGraph` | `false` | lists have no transitions (`§1.5`) |
| `webhooks` | `true` | HMAC-SHA1 deliveries (`§1.3`) |
| `webhookRegistration` | `true` | ostra creates and deletes them on the board (`§1.3`); the first tracker that does |
| `commentEdit` | `true` | ostra edits its own comment (`§1.6`) |
| `attachments` | `true` | uploads and link attachments (`§1.6`) |
| `transitions` | `false` | a direct `idList` write (`§1.5`) |
| `mentions` | `false` | a token reads only the granting member's email (`§1.6`) |
| `ticketFields.acceptanceCriteria` | `false` | no such field; core writes the criteria into the description |
| `ticketFiles` | `"all"` | the card's uploaded attachments, fetched with the credential (`§1.4`); a Markdown link to another site is never a file |
| `magicWords` | `false` | Trello doesn't link a PR by a word in its body; ostra attaches the PR's URL (`§1.6`) |
| `richText` | `"markdown"` | `desc` is Markdown (`§1.4`) |
| `jqlFilter` | `false` | no query narrows a Trello webhook |

The panel reads capabilities from the connection's adapter (`trackers.list`), never from its kind, except for words (`Lists`, `Cards`). A capability the adapter doesn't declare is never drawn as a disabled control: no Agent mode, no Sub-tasks, no Mentions, no magic-word row and no transition lines on a Trello board.

## 7. Parity

### Adapter parity

| Feature | What it asks | Linear | Jira | Trello | The fakes |
|---|---|---|---|---|---|
| F-153: key+token auth | the client's auth header and the app key | — | — | yes | two bot members, each's digest recorded |
| F-153: registration | `webhookRegistration`, `ensureBoardWebhook`, `removeBoardWebhook` | no (`unsupported`) | no (`unsupported`) | yes | the fake's `HEAD` check and its webhook list |
| F-153: a board's settings | `BoardRef.keyPrefix`, `statusCategories` | ignored | ignored | applied | the fake's `idShort` and its six lists |
| F-008/F-007: moving | `moveTicket` (`transitions` says how) | direct | by transitions | direct, `via: []` | the fake writes `idList` |
| F-149: a ticket's files | `ticketFiles`, `downloadFile` | `all` | `all` | `all` (uploads) | the fake's upload, link and redirect |
| F-153: no mentions | `findUsersByEmail` | yes | yes | `unsupported` | the fake has no email |
| F-012: agent mode | `agentSessions` | yes | no | no | the fake Linear |
| F-042: polling | `listTickets` with `updatedSince` | yes | yes | yes (`dateLastActivity`) | every fake |

The contract suite's capability cases cover each new capability on every subject, and `tracker-parity.ts`'s milestone 11 table is unchanged; the panel's words (`Lists`, `Cards`, `Sub-issues`, `Sub-tasks`) are the only place a kind's name reaches the UI.

### Runner parity

Nothing here reaches a runner. A card's files reach the box as milestone 9's do, as blobs on the bulk path, on every executor; the protocol doesn't change. The executor suite isn't touched.

## 8. Test seams

Agreed here so builders don't each invent one.
- **Postgres:** milestone 1's helper, a database per test file; every test that reads connections or boards also checks that another organization's rows stay invisible. Ticket 04 adds a Trello connection, its board and a cached ticket to the isolation test's second organization.
- **Trello:** one fake, the HTTP fake Trello (`testing/fake-trello/`, ticket 03), for `adapter-trello`'s own tests, the API's connect steps through the kit, core's webhook, registration and polling tests, the browser specs and the demo. It signs deliveries with the app secret and a callback URL on demand, and with a wrong one; it records each request's bot member, digest and host. There's no second in-memory Trello adapter: the domain's and core's unit tests take `TRELLO_CAPABILITIES` and drive the HTTP fake, because Trello's per-board settings and HMAC are the adapter's, not a fake's.
- **The connect kit:** a fake `TrelloConnectKit` in `domain/testing/`, with each step's outcomes (a refused token, a member already connected, a board list, a revoked token), for the use cases' tests.
- **Time:** the poll window, the 5-minute backstop and the 30-minute freshness read the `Clock` port.
- **Text that is data:** every test of a card's name, description, comment, checklist item or attachment name holds shell syntax, prompt-like text, a Markdown table, an unclosed code fence and a 64 KiB body, and asserts none reaches a log line or a shell command.
- **The signature:** cases for the canonical callback URL (the exact string, a trailing slash, a query), the raw body as bytes (not re-serialized JSON), a wrong secret, a missing header, a body with no `action.id`, and a constant-time compare.
- **The marks:** the existing mark test gains Trello's tile in the enabled picker; a Trello ticket's chip and Inbox row render the mark with its label or `aria-hidden` beside the word.

## 9. Every ticket's checks and commit

As milestones 1 to 11 (`specs/m11-trackers-jira/spec.md`, section 10), and the lead's rules (`C:/Users/santi/ow/_lead/AGENT-RULES.md`). In short:
- **Checks once, then push.** `pnpm typecheck`, `pnpm lint` and `pnpm test` for the touched packages (and their direct consumers when a shared type changes), with `--cache-dir=C:/Users/santi/ow/.turbo-cache`, once before each push. `pnpm check:licenses` passes. GitHub CI runs the rest; a failure from the change is fixed forward.
- **The whole-repo checks** run for tickets that touch the schema, credentials or a tracker's untrusted input: 01, 03, 04, 05 and 06.
- **Browser specs run once,** when the feature is built (ticket 09). A fix that needs browser proof runs only its own spec file.
- **Proof:** each condition of the row's "done when" has a test named with its key (`it("F-153/c1: ...")`) that exercises it through the real code path, and CI runs it. No proof file. A condition only a live run shows waits for ticket 09's manual run.
- **No secret in the commit,** and no key, secret, token or card text in a log line.
- **Dependencies:** none (section 10).
- **Stage only the ticket's own paths,** no `git add -A`, no stash. A gitmoji message of at most 50 characters, no AI attribution. Rebase onto `origin/main`, then push to `origin main`.
- **Work in a worktree** under `C:/Users/santi/ow/<name>` from `origin/main`, never in `c:/Users/santi/ostra`. Kill every process started with its whole tree, and remove the worktree at the end.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 9.1 How each condition gets proved

A condition's key is its sentence's place in the row's "done when" (`features.md`).

**F-153 Trello:**
- c1: the two steps, the consent page's key and the token read back (the member and its boards) before it's saved (03, 04, 05, 06, 08)
- c2: every call carries the key and token from the secret store, which reach no box, log line or member; a revoked token fails the connection as `token-refused` (03, 04, 06)
- c3: ostra registers a webhook per attached board itself; HMAC-SHA1 over body + callback URL verifies, wrong/missing refused; `HEAD` 200; a delivery stored once and answered at once (02, 03, 05)
- c4: polling brings a change within 60 s without a public address, and the 5-minute backstop sets the silent line (03, 05)
- c5: lists mapped to categories and steps; a move writes the list with no transition; `TR-12` keys and stable IDs (02, 03, 04, 06, 08)
- c6: a card reads as a Linear ticket (Markdown, checklists in the description, comments, labels, members, attachments); no sub-issues, mentions or priority; uploads fetched with the credential only to `api.trello.com`, one credential-less hop (02, 03, 05)
- c7: the task's and PR's links are attachments once per URL, and ostra's comment is edited in place (02, 03, 05)
- c8: the Inbox, intake rules, schedules, Create ticket, prompt tickets, reopen, sync, notifications and context on a Trello board (03, 05, 06)
- c9: the tracker contract suite passes for `adapter-trello` against the fake Trello, with the capabilities it declares (no agent sessions, no transitions, no sub-issues, no mentions) (02, 03, 04)
- c10: the picker offers Trello enabled; a connection's page, a board's list mapping and prefix, Trello's mark wherever a ticket shows; a disconnected board paused and resumed (06, 07, 08)
- c11: the live run on the maintainer's Trello test account takes a card to a merged PR (09, after 10) — **needs** the maintainer's test account

## 10. Dependencies

**None.** Trello's API is REST and JSON with two credential strings; a hand-written client on `fetch` with Zod schemas is enough, as Linear's and Jira's are. HMAC-SHA1 is the runtime's `crypto` (`createHmac("sha1", secret)`), which the GitHub adapter already uses for its signatures. Multipart uploads use `FormData` and `Blob`, which the repo's Node 24 (`package.json`'s `engines`) has. No Trello SDK is proposed; if the maintainer prefers one, that's a question before any dependency is added (`AGENTS.md`).

## 11. What research leaves unverified, and how this spec handles it

`research/trello-and-notion.md` marks these **unverified**; none is assumed true in the code paths above.

| Open fact | How the build handles it | Owner |
|---|---|---|
| Whether an uploaded attachment's download route answers with a 302 to signed storage, and whether forwarding the credential breaks it (`§1.4`) | `downloadFile` sends the credential only to `api.trello.com` and follows one hop to storage **without** it; a fake reproduces the 302; the live run (09) confirms the real answer. The contract's "no redirect is followed" is amended to "at most one hop, without the credential" (ticket 02) | ticket 03, 09 |
| The board-cards route and its paging parameters; whether a card is readable by `idShort` directly (`§1.1`, `§1.7`) | `listTickets` uses the board-cards route with a bounded page and a cursor; a key lookup scans the board's cards; the builder confirms the exact route against the REST reference in ticket 03, and the live run confirms it | ticket 03, 09 |
| The webhook payload's field names beyond `action` (`action.id`, `action.date`, `action.memberCreator`, `action.data.card.id`, `model.id`), and the fields that show a list move (`§1.3`) | the adapter's Zod schema reads them loosely (unknown fields tolerated), the fake sends the documented shape, and the live run confirms; a missing `action.date` means no freshness check, never a guess | ticket 03, 09 |
| A card `desc`'s length limit and an upload's size limit (`§1.4`, `§1.6`) | a working cap on `attachFile` (10 MiB) and an upload's error surfaced as `invalid-input`; the limits are recorded in the docs and replaced with the measured ones after the live run | ticket 03, 08 |
| Whether inline images in a `desc` point at the card's own attachment URLs (`§1.4`) | they are links, never fetched; only uploads are files; `filesInText` recognizes a link to one of the card's own attachment URLs and nothing else | ticket 03 |
| Whether creating a Trello app needs a Workspace and who may create one; whether a bot member costs a seat on a paid Workspace (`§1.2`) | the docs say the app and the bot member are the admin's, on a real Workspace, and that a seat may be charged; the live account records which | ticket 08, 10 |
| Trello's Developer Terms and a self-hosted tool holding a token (`§1.2`) | not read; the docs quote Atlassian's own advice that API tokens are for apps without a logged-in user, and the maintainer decides before the feature ships | ticket 10 |
| Whether a comment's edit is visible to a poller (`§1.3`) | the webhook delivery carries `updateComment`; polling reads the context's current text when it reads the ticket, so a missed edit is corrected on the next read; the docs say so | ticket 03, 08 |

**Open questions this spec proposes** (to add to `context/open-questions.md`; the maintainer's, nothing waits on them for the first build):
1. **The download's one hop.** May `downloadFile`'s contract allow one redirect to the tracker's storage without the credential (section 5.2), or should Trello's uploads be fetched some other way?
2. **Several members.** A card has several members and ostra models one assignee. Keep the first member as the assignee (the research's recommendation), or add an `assignees` list to `Ticket` and the cache (a new contract, a new column)?
3. **Description images.** Should ostra fetch an image a card's description shows, once the live run says whether it's an attachment URL, or keep only uploaded attachments as files?
4. **The bot member's seat.** If the test Workspace charges a seat for the bot member, does the docs' setup still stand, or does ostra prefer a token from a guest member?
5. **OAuth 2.0's future.** Atlassian says there's no deprecation timeline for API tokens (`§1.2`). Revisit when it announces one; until then the app key and bot token stand (ADR 0072).
6. **The payload's shape.** The live run records the real `action` fields; if they differ from `§1.3`'s guess, the fake and the schema follow the live body.

## 12. Builders and their tickets

Four builders: **core**, **api**, **web** and **adapters** (ticket 03 may run as one agent, the Trello agent), plus the **maintainer** (10). The contracts land first (01, 02); ticket 03 runs beside them against the interface as 02 leaves it.

| # | Ticket | Builder | Blocked by | Visual |
|---|---|---|---|---|
| 01 | DB: the Trello migration | core | none | no |
| 02 | Adapter SDK: the callback URL, webhook registration, a board's settings | adapters | none | no |
| 03 | Trello adapter: the client, cards, lists, keys, webhooks, files, polling and the fake Trello | adapters (the Trello agent) | 02 | no |
| 04 | Domain: the Trello kind, its connect steps, the board's settings | core | 01, 02 | no |
| 05 | Core: the Trello webhook and HEAD, registration, polling, sync and context | core | 03, 04 | no |
| 06 | API: connecting Trello, boards with a prefix and categories, the ticket's tracker | api | 03, 04 | no |
| 07 | Web: Trello in the picker, its connect steps, settings and board mapping | web | 06 | yes |
| 08 | Docs: Trello under Trackers, the configuration reference | core | 06 | no |
| 09 | The end-to-end demo and the ledger | core (lead) | 01 to 08; 10's test account | no |
| 10 | The maintainer's steps outside the code | maintainer | none for the test account; 09 for the review of the run | no |

**Who starts when.**
- **core** takes 01 at once, then 04, then 05 as 03 lands.
- **adapters** take 02 at once, then 03 (rebasing on 02 when it lands; 02's comments say which methods and types 03 implements).
- **api** takes 06 once 04's use cases and 03's kit are in.
- **web** builds 07's components against the m11 targets meanwhile, and wires them as 06 lands. Milestone 11's screens are its base; its own targets are section 13.

## 13. Screens and their targets

`build-order.md`: a milestone's screens are designed first, image first. **Trello's targets are not drawn yet.** They're needed before ticket 07's build: a `context/brand/app-targets/post-v1-trello/` set, approved by the maintainer, that reuses the m11 targets' shell and adds:
- the picker with Trello's tile enabled and only Notion "Coming soon" (`trackers.md`, `trackers-picker`);
- Trello's two connect steps and the consent hand-off (`jira-connect.md`'s pattern);
- a Trello connection's settings (`connection-settings.md`'s pattern): the bot member, the mode, Replace the token, Replace the app secret, Re-register webhooks, Check again, Rename, Disconnect;
- a board's attach and mapping: the prefix, the lists with a category each, and the started/in-review/done steps (`boards-mixed.md`'s pattern);
- the task's "On Trello" rows (the list each move wrote) and Trello's chip (`ticket-chips.md`'s pattern).

Ticket 07 may not start before those targets are approved. The design pass is the orchestrator's, scheduled before 07 and not one of these ten tickets; until the pictures exist, this spec's section 1 is the build spec's behaviour.

## 14. Glossary and domain model

Added by ticket 04, in `GLOSSARY.md`:
- **Bot member:** a Trello member created for ostra, added to the boards ostra works, whose never-expiring token is the connection's credential. It is never a person's account.
- **Card list:** one of a Trello board's lists; a card's status. It carries no category, so an admin maps each list to ostra's four categories and to the started, in-review and done steps.
- **Trello board prefix:** the short uppercase prefix an admin gives an attached Trello board (`TR`), stored in `Board.key`, so a card's key is `TR-12` beside its stable card ID.

`domain-model.md` gains Trello's connection arm (the m11 lifecycle) and the note that a Trello board's statuses are lists, moved by a direct write.
