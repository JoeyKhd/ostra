# Milestone 11: Trackers and Jira

**Status:** spec, 2026-11-23. Tickets in `issues/`, one file each (`docs/agents/issue-tracker.md`).
**Milestone:** 11 (`context/build-order.md`). It lands before milestone 7's held launch gate, as milestones 8 to 10 do, so the gate's load test, security review, measure and demo run once, on a product that already has it.
**Features:** F-008 (Jira, moved into v1 on 2026-11-23) and F-152 (trackers: several connections per organization). It re-homes F-005 (Linear's connection), and grows F-007 (boards), F-042 (private installs), F-076 (setup), F-097 (prompt tickets) and F-149 (ticket files) to Jira; section 2 lists the rows that get a note.
**The maintainer, 2026-11-23:** "Our UI looks like Linear is a section on its own"; several tracker connections per organization, of any kind, the way model keys work per client; a project's Boards attach boards from any connection; the organization page is called "Trackers" and replaces Organization › Linear; Jira Cloud is built now; Trello and Notion appear in the picker as "Coming soon"; "show the logo of each one jira etc, that looks nicer"; and, once the targets were drawn, "start building immediately".
**Approved the same day:** the design targets in `context/brand/app-targets/m11-trackers/` ("yes to all"): every picture, the six build specs, `html/`, and the README's fifteen choices, each settled as recommended (section 12). The README's "What the build needs beyond the pictures" is this spec's contract too.
**Decisions it builds on:** ADR 0013 (trackers as adapters, Linear's two modes), 0025 (everything is an adapter), 0026 and 0053 (organizations, isolation), 0030 (no credential in the box), 0035 and 0037 (the event log, the durable queue), 0043 (blobs), 0047 (Jira's service account and admin webhook), 0057 (starting from Linear), 0065 (clients in one organization), 0070 (a ticket's files). **New for this spec:** ADR 0071 (several tracker connections per organization), which amends ADRs 0013 and 0047.
**Research it rests on:** `research/trackers.md` §2 (Jira Cloud: REST v3 and ADF, `/search/jql` and `nextPageToken`, transitions, admin webhooks, no Data Center, no Connect, no Rovo connector in v1) and §3 (the abstraction), and `research/trello-and-notion.md` (why Trello and Notion wait).
**Builds on milestones 1 to 10** as they were built, not only as they were specified. Where their code ends up different from their specs, this spec follows the code, and the ticket that meets the difference says so in its `## Comments`.

Terms follow `context/GLOSSARY.md`. A **tracker connection**, a **paused board** and a **target status** are new, and in the glossary from this spec's commit. Lifecycles follow `context/domain-model.md`, which ticket 05 grows.

---

## 1. What milestone 11 ends with

An organization connects each client's tracker, Linear or Jira, and every project attaches the boards it works from, whichever tracker they're on.

In more words. Organization › Trackers lists every tracker connection: Acme's Linear workspace, Globex's Jira site, Northwind's Linear, each with its mark, its name, its site, how its events arrive and whether they do. "Connect a tracker" picks Linear or Jira (Trello and Notion show as "Coming soon"). Jira connects in three checked steps: the site, the service account's scoped API token (ostra reads back who it is and what it reaches before saving it), and the admin webhook with a secret ostra makes, or polling when Jira can't reach the install. Each connection has its own page: its events, its token, rotate, re-check, rename, disconnect. A project's Boards attach a Linear team and a Jira project side by side; a Jira board maps each of ostra's steps to a target status and shows which workflow transition reaches it, and warns where none does. A Jira ticket shows everywhere a Linear one does, with its mark: the Inbox, the task's header and panel, what the agent got, the sidebar and search. A task started from a Jira ticket gets its description and comments as markdown, its sub-tasks and its files, posts its progress as one comment it edits, links the task and the PR, and moves the ticket through the workflow as it starts, opens its PR and merges. Disconnecting a connection pauses its boards; connecting the same site again resumes them.

### What milestones 1 to 10 leave that milestone 11 starts from

Read from the code on `main` on 2026-11-23 (`01cf88d8`), so builders don't rebuild what exists:

- **The tracker interface is shaped for two trackers already.** `TrackerAdapter` (`packages/adapter-sdk/src/tracker/base.ts`) has `moveTicket(board, ref, target, mapping)` ("Linear sets the status; Jira walks its transitions"), `updateComment`, `linkTask`, `createTicket`, `getTicketContext` with `files`, `downloadFile`, `verifyWebhook` and `parseWebhook`. `TrackerCapabilities` (`capabilities.ts`) declares `agentSessions`, `subIssues`, `statusGraph`, `webhooks`, `commentEdit`, `attachments`, `transitions`, `mentions`, `agentScopes`, `agentSessionLink`, `ticketFields` and `ticketFiles`.
- **An in-memory Jira fake runs the tracker contract suite** (`packages/adapter-sdk/src/testing/jira-fake.ts`, 1,247 lines): a status graph walked by transitions (a missing path is `conflict`), ADF with `adfToMarkdown` and `markdownToAdf`, keys that change on a project move, `X-Hub-Signature` and `X-Atlassian-Webhook-Identifier`, the per-issue write limit, attachments and ADF `media` nodes (`ticketFiles: all`). It's a `TrackerAdapter` over an in-memory site, not an HTTP server, and it never ships. There is no `adapter-jira` package.
- **The schema holds one Linear connection per organization.** `Connection` (`packages/db/prisma/schema.prisma`) has `kind` (`github`, `linear`), `state` (`pending`, `active`, `failed`, `revoked`), `webhookMode`, `credentialKind`, the `externalWorkspace*` columns, `appUserId`, the secret refs, `lastEventAt`, `webhooksSilentSince`, `scopes`, `agentModeAt`, and **no name**. A partial unique index, `connection_one_linear_per_organization`, allows one Linear row not `revoked` per organization. A pending Linear row's `appId` is the placeholder `pending` (`linearAppIdPlaceholders`), unique under `(organizationId, kind, appId)`, so two pending rows can't exist. `Board` keys to a connection already (`connectionId`), but its key is `(projectId, externalId)`, so two connections' boards with the same external ID can't sit in one project. `OrganizationSetting.linearSkippedAt` holds the skipped setup step.
- **Every caller finds "the organization's Linear":**
  - the API: `services/trackers.ts`'s `linearConnectionOf` (`findFirst({ kind: "linear", state: { not: "revoked" } })`) and its `forConnection`, which refuses any kind but `linear`; `routers/boards.ts`'s `requireTracker`, `teams`, `available` and `get`; `routers/inbox.ts` (line 155); `routers/notifications.ts` (`tracker: { kind: "linear" }`); `routers/setup.ts` (the `linear` step, `linearSkippedAt`); `routers/linear.ts` (`status` and every procedure, one row per organization);
  - the domain: `use-cases/linear-connection.ts` (`startLinearConnection` reuses the one row not revoked; `disconnectLinear`; `ConnectionTracker`), `use-cases/boards.ts` (attach checks `kind: "linear"`), `setup/timeline.ts` (the `linear` step, `linear.connected`);
  - core: `tracker/ingest.ts` (polls only `kind === "linear"`), `tracker/connections.ts` (builds Linear's adapter, `null` for any other kind), `webhooks/inbox.ts` (`/webhooks/(linear|github)/:connectionId`, verifiers by kind), `webhooks/process.ts` (handlers `linear` and `github`);
  - the panel: `/organization/linear` (`app/(panel)/organization/linear/page.tsx`, `components/linear/linear-view.tsx`, `linear-panel.tsx`, `agent-mode.tsx`), the organization panel's `Linear` place (`components/shell/places.ts`), Home's `linear` step (`components/home/setup-checklist.tsx`, `setup-steps.tsx`), the new project's tracker (`components/projects/new-project-view.tsx`: none or a Linear team), the task's ticket (`components/tasks/task-ticket.tsx`: `from Linear`, `On Linear`, `Open in Linear`), and the copy under `linear.*`, `agentMode.*`, `checklist.linear.*` (`apps/web/messages/en.json`).
- **Linear-only parts stay Linear's:** agent mode (`apps/core/src/linear/agent-mode/`, `domain/use-cases/agent-mode.ts`), the token refresh (`apps/core/src/tracker/refresh-token.ts`), outside starts (`starts/outside.ts`, kind `linear`), and the OAuth callback (`apps/web/src/app/api/linear/callback/route.ts`). They're already routed by connection ID; this milestone gates them on the adapter's `agentSessions`, not on the organization having "a Linear".
- **What's tracker-neutral already:** the ticket cache (`Ticket` keys on its board), ticket sync's planned writes (`domain/tickets/ticket-writes.ts`), the mapping (`boardMappingSchema`: `open`, `started`, `inReview`, `done`, `ready`, `doneBy`, `magicWord`), ticket context and its files (`apps/core/src/tracker/context.ts`, milestone 9), the drift poll's cursor per board, the webhook inbox's claim-then-200 (`WebhookDelivery` unique on `(connectionId, deliveryId)`), and the needs-you item for a failed connection.
- **The settings:** `OSTRA_LINEAR_API_URL` (a fake Linear in tests), `OSTRA_TRACKER_POLL_SECONDS` (60), `OSTRA_CORE_PUBLIC_URL` (webhooks or polling).
- **The launch gate is held:** milestone 7's tickets 25 to 28, 32 and 33, and the demos of milestones 8, 9 and 10, wait for the maintainer's word (`build-order.md`). Milestone 11's own demo joins them.

### What is in, and what is not

**In:**
- several tracker connections per organization, of any kind, each named, with its own credentials and webhook; one per site or workspace; isolation between them;
- Organization › Trackers (list, picker with Trello and Notion "Coming soon", empty state, states, phone), replacing Organization › Linear, with `/organization/linear` redirecting;
- a connection's page: Jira's three connect steps, and its settings; Linear's page re-homed, with Agent mode as a Linear-only section;
- Jira Cloud's adapter: the service account's scoped token through `api.atlassian.com/ex/jira/{cloudId}`, REST v3, ADF both ways, JQL and `/search/jql` paging, transitions, the admin webhook (HMAC, dedupe), comments edited in place, remote links, sub-tasks, a ticket's files, polling;
- the connect steps' checks: the site's cloud ID, the token's read-back (who, which projects, which permissions, whether workflows read), the webhook's first signed delivery, polling without a public address;
- the token's expiry date, its warning and failure; Replace the token; Rotate the secret; Check again; Rename; Disconnect with paused boards, and resume;
- a project's Boards from any connection: the attach picker grouped by connection, Jira's mapping by target status with each step's transition and the warnings, Done moved by ostra or by Jira automation, paused and failed boards;
- the tracker marks (Linear, Jira, Trello, Notion), in brand colour or one colour, everywhere a tracker or a ticket shows;
- Home's step 4, "Connect a tracker", for either kind;
- Jira through every flow Linear has outside agent mode: the Inbox, intake rules, schedules, Create ticket and prompt tickets, ticket context and files, sync, reopen, sub-tasks, notifications on the ticket;
- the docs: a Trackers page, a Jira page, Linear's page re-homed under Trackers, the configuration reference.

**Not in** (and when it comes):
- Jira Data Center or Server: not planned (ADR 0047). Step 1 recognizes a Data Center address and says so.
- Atlassian's Rovo agent connector, and anything like agent mode on Jira: not planned (research §2.6). Jira's adapter declares no agent sessions.
- Connect apps, Forge apps, OAuth 3LO: not planned (ADR 0047).
- Jira's Development Information API (`/rest/devinfo`) through 2LO credentials: later, if Jira's GitHub integration isn't enough (research §2.5, S-13). The key in the branch and the PR's title links the PR, and ostra adds remote links.
- Trello: the next tracker after this milestone, once someone asks (`research/trello-and-notion.md`). Its tile is "Coming soon".
- Notion: later, behind a spike on its property mapping and webhook verification. Its tile is "Coming soon".
- Several organizations per install connecting one site: allowed and kept apart, but only F-134 (after v1) makes it happen.
- Registering Jira's admin webhook for the admin: not planned; it needs an admin's own credentials (ADR 0047).

### On this machine

The same adjustment as milestones 1 to 10: the scripted demo runs here on the `host` executor, with the fake Jira (ticket 03's HTTP fake) and the fake Linear. What needs more than that:
- **A real Jira Cloud site with a service account, a scoped token and an admin webhook,** and a public address for its deliveries (the tunnel milestone 2 uses for Linear): the manual run, once (ticket 18), after the maintainer creates them (ticket 19).
- **S-12, whether a service account's scoped token reads the workflow graph** (`/rest/api/3/workflows/search` with `read:workflow:jira`), and **S-10, whether service accounts need a paid plan,** are answered on that site (ticket 04's live test, ticket 19). Until then the workflow read is proved against the fake, and the panel's "can't read workflows" state covers a real site that says no.
- **People:** the maintainer's test site and service account (ticket 19).

---

## 2. The features, and where each one lives

"At M11's end" is the ledger status ticket 18 sets at the launch gate, if and only if every condition in the row's "done when" holds.

| F-ID | What milestone 11 builds | Packages | Tickets | At M11's end |
|---|---|---|---|---|
| F-152 Trackers | Several connections per organization, named, one per site; isolation; the Trackers page and picker; a connection's page; boards from any connection; paused boards and resume; the marks; Home's tracker step; Linear's connection migrated to the first named one (ADR 0071) | `packages/db`, `adapter-sdk`, `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `apps/docs` | 01, 02, 05, 07, 09, 10, 11, 12, 14, 15, 16, 17 | done |
| F-008 Jira | Jira Cloud's adapter and its fake; the connect steps and their read-back; the admin webhook and polling; transitions and the target-status mapping; ADF; sub-tasks; files; every flow Linear has outside agent mode; the token's expiry; rotate and replace (ADR 0047) | `adapter-sdk`, `packages/adapters/adapter-jira` (new), `packages/db`, `packages/domain`, `apps/core`, `packages/api`, `apps/web`, `apps/docs` | 01 to 10, 12 to 17 | done, once the live run on the maintainer's test site passed (c10); otherwise `building` with the fake Jira proved |

**Rows this milestone touches without finishing:**
- **F-005 (connect Linear)** moves under Trackers, its connection named, one of several. Its conditions stand; a note says where it lives. No new status.
- **F-007 (boards)** attaches boards from any connection. No new status.
- **F-042 (private installs)** covers Jira by polling. No new status.
- **F-076 (setup in the panel)**: step 4 is "Connect a tracker". No new status.
- **F-097 (prompt tasks)** and **F-149 (ticket files)** work on a Jira board as on a Linear one; their conditions already name the tracker interface. No new status.
- **F-012 (start from Linear)** is gated on the connection's adapter declaring `agentSessions`, per Linear connection. No new status.

**Built in from the first milestone** (`build-order.md`), checked again by ticket 18:
- **Organization-scoped data:** every new column is on `Connection`, `Board`, `TicketWrite` or `OrganizationSetting`, all organization-scoped; no new table. Milestone 4's generated isolation test stays green, and ticket 05 adds a two-connections case to it.
- **The event log and the durable queue:** a delivery is claimed then answered; the first delivery's activation, a resume's board move and a disconnect's pause are each one transaction; every poll, read-back re-check and expiry check is a job (05, 06, 07).
- **No credential in the agent's container:** Jira's token stays in core and the API; a ticket's files reach the box as blobs (milestone 9).
- **Adapters for every integration:** Jira is an `adapter-jira` package extending `TrackerAdapter`, passing the tracker contract suite (03).
- **Strict typing, dark first, responsive, English text in message files,** and milestone 7's keyboard walk and contrast check on the new screens (11 to 16).

---

## 3. The end-to-end demo

Ticket 18 runs it **at the launch gate**, with milestone 7's ticket 32 and the demos of milestones 8, 9 and 10, and records the result under its `## Comments` and in `demo.md` next to this spec. The live part runs against the maintainer's Jira Cloud test site (ticket 19 names it; below `ostra-test.atlassian.net`, project `OJ`), the Linear workspace `ostra-test` (team `OST`) and the GitHub org `ostra-test`, repo `test1`. Secrets come from `~/.config/ostra-dev/` with `set -a; . ~/.config/ostra-dev/<file>; set +a`, and are never printed, logged or committed.

**Two runs.** The scripted run (`pnpm e2e:m11`, `e2e/m11-trackers-jira/`) runs every step it can without a person, on the `host` executor, with ticket 03's fake Jira at `OSTRA_JIRA_API_URL` and the fake Linear at `OSTRA_LINEAR_API_URL`, two fake Jira sites and two fake Linear workspaces. The manual run, once, in a real browser, connects the real test site with its real service account and admin webhook through the tunnel, and takes a real `OJ` ticket to a merged PR.

**Before:** a fresh clone, `pnpm install`, `pnpm dev:reset`, `pnpm dev`, and milestones 1 to 10's helpers: a model provider, the test App on `test1`, a project `test1`, a personal runner on `host`. The panel signs in as `demo@demo.com` / `demo`. Sam joins by invitation as an organization member (not an admin).

1. **The upgrade.** The scripted run starts from a database at milestone 10 with one Linear connection, two boards, its setup step done, agent mode on, and tickets cached. After the migration: Trackers lists it as `ostra-test Linear`, connected; its boards, tickets, agent mode and Home's step are as they were; `/organization/linear` lands on its page.
2. **No connection yet.** In a second organization's fresh database (the scripted run's second world), Trackers is the empty state with the picker on the page; Trello and Notion are "Coming soon", not focusable. Home's step 4 reads "Connect a tracker", with both marks.
3. **Connect Jira by webhook.** Demo presses `Connect a tracker`, picks Jira, `Continue with Jira`. Step 1: the site `ostra-test`, the name prefilled `ostra-test Jira`, `Find the site`: done, with the cloud ID. Step 2: the service account's email, its token and its expiry date, `Check the token`: four green lines (a service account, the projects, the permissions, workflows readable). `Save and continue`. Step 3: the URL, the secret, six events and the suggested JQL, each copied. Demo makes the webhook in Jira (the manual run) or the run posts a signed delivery (the scripted run): the page turns into the settings with `Just connected`.
4. **The step's failures.** A site that doesn't answer; a Data Center address; the same site again (refused, naming the existing connection, with `Open it →`); a person's token (red, a person's account); a token that sees no project; a token without `read:workflow:jira` (saves with the warning); a refused token (401); a delivery with a wrong signature (the wait row red, `Make a new secret`). Each says what the target says.
5. **Polling instead.** With `OSTRA_CORE_PUBLIC_URL` unset, a second Jira site connects: step 3 is `Events: polling`, `Finish`. A ticket edited on the fake reaches the Inbox within 60 seconds by polling alone.
6. **Two clients.** A second Linear connection (`Northwind Linear`, another fake workspace) connects beside the first. Trackers lists four connections with their marks, modes, last events and states. Sam sees the list without `Connect a tracker`, and a connection's page without its webhook URL, secret, Rotate or Disconnect.
7. **Mixed boards.** On `test1`'s Boards, the attach picker groups each active connection's teams and projects; Demo attaches `OST` (Linear) and `OJ` (Jira). The Jira board's mapping is drafted from its workflow: each step's target status with `by <transition>, from <statuses>`, a warning for a status no transition leaves toward In Review, and Done moved by ostra. Two Jira sites' projects with the same ID `10000` attach to one project as two boards.
8. **A Jira ticket becomes a task.** The Inbox lists `OJ-1` with Jira's one-colour mark, `CALC`-style keys from Linear beside it. Demo starts it. The first message's "What the agent got" holds the description and comments as markdown (from ADF: a heading, a list, a code block, a mention, a link), the sub-task count and the ticket's files (an inline image and an attached `.docx`, F-149). The ticket moves to In Progress by its `Start progress` transition; ostra's progress comment appears in ADF, and the task's remote link.
9. **The PR and Done.** The agent opens a PR whose branch and title carry `OJ-1`. The ticket moves to In Review by its transition. ostra's comment is edited in place, not posted again. The PR merges: ostra moves the ticket to Done. On a second board with `Done is moved by: Jira automation`, ostra doesn't move it and the board says a rule must.
10. **A status with no way there.** A ticket in `Blocked` (no transition to In Review) gets its PR: it stays put, and ostra's comment says so. The task page's "On Jira" rows say which transition each move used.
11. **Echoes and duplicates.** Every delivery of ostra's own writes (the service account's `accountId`) is stored and not acted on. The run replays one delivery five times: one row, one action.
12. **Rename, re-check, rotate, replace.** Demo renames the Jira connection: Boards, the Inbox's tooltips and the panel show the new name. `Check again` reads back with the saved token. `Rotate the secret` (confirmed) shows a new one; the next delivery signed with the old one is refused and counted as a bad signature; one signed with the new one is accepted. `Replace` saves a new token after its read-back.
13. **The token's date.** The scripted run's clock moves to 13 days before the expiry: the connection's row, its page and Home say `Token expires`, and the admins get one needs-you item. On the day, the connection is `failed`, its boards pause, and `Replace` is the page's one primary.
14. **Disconnect and resume.** Demo disconnects the Jira connection: the dialog names its boards and says ostra can't delete Jira's webhook. Boards shows the `OJ` board paused, with its pause line and `Trackers →`; nothing moves on Jira; its tickets and tasks read. A delivery to the old URL is answered `410`. Demo connects the same site again: the board resumes on the new connection with its mapping, and the next poll picks up from its cursor.
15. **Linear unchanged.** A Linear ticket on `OST` runs end to end as milestone 2's demo did, and agent mode still takes a delegation on its board (the fake Linear session).

**The checks after the run** (ticket 18 scripts what it can, in `e2e/m11-trackers-jira/`):
- **Nothing leaked.** No token, webhook secret, ticket text or comment body appears in any log line, event's log field, URL ostra built or panel response to a member (searched by value, never printed).
- **Kept apart.** Every tracker call of the run went to its own connection's host with its own credential: the fakes record each request's credential digest and site, and no request of one connection carries another's.
- **Parity.** The tracker contract suite passes for Linear, the in-memory Jira fake, `adapter-jira` against the HTTP fake Jira, and the tiny adapter.
- **Clean-up:** the demo's `OJ` and `OST` tickets archived, its PRs closed and branches deleted, in `test1` only.

---

## 4. How it fits together in milestone 11

```
 browser ──▶ apps/web: Organization › Trackers (list, picker, empty), /organization/trackers/<id>
   │                    (Jira's steps, a connection's settings, Linear's page re-homed),
   │                    Boards (attach from any connection, Jira's mapping), Home's step 4, the marks
   │     └─ tRPC: trackers.list / get / create / rename / disconnect,
   │              trackers.jira.findSite / checkToken / saveToken / replaceToken / webhook /
   │                            finishPolling / rotateSecret,
   │              trackers.linear.* (today's linear.*, per connection),
   │              boards.attachable / attach / get / workflow / setDoneBy, setup.status's tracker step
 api ──▶ the connect kit (adapter-jira): tenant_info, /myself, project search, /mypermissions,
   │       workflow search — with the token being checked, never stored before a pass
 Jira ──webhook──▶ core POST /webhooks/jira/<connectionId>: X-Hub-Signature under that connection's
   │                 secret → claim (X-Atlassian-Webhook-Identifier) → 200 → job: fetch, ingest
 core ──poll──▶ Jira /rest/api/3/search/jql (bounded JQL, updated >= cursor, nextPageToken),
   │             per board, every 60 s without a webhook, every 5 min as a backstop
 core ──▶ the tracker (adapter, per connection, its own token): moves by transition, ADF comments
   │       edited in place, remote links, sub-tasks, files
 core ──▶ Postgres: connections (named, per kind), boards per connection, paused when not active
```

**The flows:**
- **Connecting Jira** (06, 09, 13). `trackers.create({ kind: "jira", name })` makes a `pending` connection with `appId` `pending:<id>`, audited `tracker.connection-created`. `trackers.jira.findSite` reads `https://<site>.atlassian.net/_edge/tenant_info` through the connect kit (04) for the cloud ID, refuses a Data Center address and a site another connection of the organization holds (ADR 0071), and sets `appId` to the cloud ID and the workspace columns. `trackers.jira.checkToken` runs the read-back with the pasted token (in memory only), and answers four checks; `saveToken` stores the token in the secret store only after a pass or warnings only, with the email and the expiry date, and the last read-back. `trackers.jira.webhook` makes the webhook secret on its first call while pending (32 random bytes, base64url, through the secret store), and answers the URL, the secret while no delivery has arrived, the six events and the suggested JQL. The first delivery with a valid signature activates the connection (07): `state` `active`, `firstDeliveryAt`, `activatedAt`, a resume if the site was disconnected before, `tracker.connected`. Without a public address, `finishPolling` activates it at once in polling mode, with no secret.
- **An event** (07). `POST /webhooks/jira/<connectionId>` reads the raw body, finds the connection (any state but `revoked`, else `410`), verifies `X-Hub-Signature: sha256=<hmac>` under its secret through the adapter's `verifyWebhook`, claims `(connectionId, X-Atlassian-Webhook-Identifier)` and the signature's hash in one insert, answers 200, then enqueues the same processing job as Linear's: the adapter's `parseWebhook` gives the hint (ticket or comment, created, updated or deleted, the actor), an echo of the service account is recorded and skipped, and the job fetches the ticket through the adapter before ingesting it. A bad signature on a pending connection sets `badSignatureAt` for step 3's red row.
- **Polling** (07). Every board whose connection is `active` is polled by its own connection's adapter: every `OSTRA_TRACKER_POLL_SECONDS` in polling mode, and every 5 minutes as the drift backstop with webhooks (F-044), from the board's cursor minus the overlap. Jira's `listTickets` is `/search/jql` with `project = <id> AND updated >= "<cursor>" ORDER BY updated ASC`, paged by `nextPageToken`. A drift poll that finds changes the webhooks never brought sets `webhooksSilentSince`.
- **A move** (08). Ticket sync's planned move calls `moveTicket(board, ref, target, mapping)`. Jira's adapter reads the ticket's available transitions, takes the one whose `to` is the target status, or the shortest route of at most three through the workflow (`routeTo`, 02), performs each, and answers `via` (the transitions' names) for the task's "On Jira" rows. None reaches: `conflict`, and ticket sync writes the progress comment's line instead (`movedNot`), as the target's warning says.
- **A disconnect** (06, 09). `trackers.disconnect({ id })` deletes the connection's secrets, revokes Linear's token at Linear, ends its open agent sessions, sets it `revoked` with its `appId` given back, and audits `tracker.disconnected`. Its boards pause by derivation (their connection isn't `active`): polling, moves, comments, rules and schedules skip them. A later connection of the same kind and site, once `active`, takes the paused boards and their tickets in the same transaction (`resumeBoardsInTx`, 05), audited `tracker.resumed`.
- **The token's date** (07). `tracker.token-expiry`, daily: a Jira connection 14 days or less from `tokenExpiresOn` opens one needs-you item for the organization's admins; on the day, the connection becomes `failed` (`failedReason` `token-expired`) and its boards pause. Jira answering 401 on a saved token fails the connection the same way at once (`token-refused`).

---

## 5. The contracts

Every contract change in milestone 11 is **additive**, with the two constraint drops ADR 0071 records: a new optional column, a new enum value, a new procedure, a new method with a base answer. Each lands as one small commit that names the contract and updates every caller in the same commit. Tickets 01, 02 and 05 make them first, each with the fakes its callers test against; ticket 03 (in progress) builds Jira's adapter against the contract as it stands, and ticket 04 adds what 02 adds.

### 5.1 `packages/db`: the milestone 11 migration (ticket 01)

One new migration after `20261203110000_box_released_with_its_session`, named `<timestamp>_milestone_11`.

| Change | What |
|---|---|
| `ConnectionKind` | + `jira` |
| `ConnectionCredential` | + `service_account_token` (Jira's scoped API token) |
| `Connection` | + `name` (String, null; filled by the migration for every tracker row, required by the domain for new ones); + `accountEmail` (Jira's service account email); + `tokenExpiresOn` (`@db.Date`: the date the admin gave; Jira's API doesn't return it); + `accessCheck` (JSON, the last read-back, parsed by the domain's `trackerAccessCheckSchema`: per project its key, ID, name and the five permissions, and `workflowsReadable`; IDs and names only); + `accessCheckedAt`; + `firstDeliveryAt` (the first signed delivery: the secret is shown until then); + `badSignatureAt` (the last delivery refused for its signature); + `resumedIntoId` (a revoked connection's successor, which took its boards) |
| Jira's use of the existing columns | `appId` the site's cloud ID (`pending:<id>` before step 1); `externalWorkspaceId` the cloud ID; `externalWorkspaceKey` the site's host (`globex.atlassian.net`); `externalWorkspaceName` the site's title; `appUserId` and `appUserName` the service account's `accountId` and display name (the echo filter); `accessTokenSecretRef` the scoped token; `webhookSecretSecretRef` the secret ostra made; `scopes` the scopes the last read-back confirmed; `webhookMode`, `lastEventAt`, `webhooksSilentSince`, `activatedAt`, `failedReason`, `createdByMemberId` as Linear uses them |
| New index | `connection_one_site_per_organization`: unique `(organizationId, kind, externalWorkspaceId)` where `kind <> 'github' AND state <> 'revoked' AND "externalWorkspaceId" IS NOT NULL` |
| Dropped index | `connection_one_linear_per_organization` (ADR 0071: a constraint, no data) |
| `Board` | new unique `(projectId, connectionId, externalId)` (`board_one_per_connection_board_per_project`); the old `(projectId, externalId)` key dropped (ADR 0071) |
| `TicketWrite` | + `via` (JSON, null: the transitions a move used, `[{ id, name }]`, for the task's "On Jira" rows) |
| `OrganizationSetting` | + `trackerSkippedAt`; `linearSkippedAt` stays, written beside it until the release after milestone 11 |

**What the migration does to data**, in the same SQL:
- `name` for each `linear` row: `"externalWorkspaceName" || ' Linear'` (`Acme Linear`), or `Linear` when the workspace was never read.
- a pending Linear row's `appId` `pending` becomes `pending:<id>`.
- `trackerSkippedAt` copied from `linearSkippedAt`.

The migration test (`packages/db`) runs it over a milestone 10 database with one Linear connection (active, agent mode on), two boards, cached tickets, a revoked older Linear row, and a skipped setup step, and checks every row reads back as above, the indexes exist and the old ones don't, and the isolation test passes.

### 5.2 `packages/adapter-sdk`: the workflow, the move's route, and two words (ticket 02)

Implemented by Linear, the in-memory Jira fake, the tiny tracker and, once it exists, `adapter-jira`, in the same commit (adapter parity, `AGENTS.md`). If ticket 03 hasn't landed, ticket 04 implements them for `adapter-jira`.

- **Capabilities, new:**
  - `magicWords: boolean`: a PR's body links the ticket with the board's magic word (`Closes`, `Refs`). Linear `true`; Jira `false` (its GitHub integration links by the key in the branch and the title, which ostra always writes). Without it the panel draws no magic-word row and `linkPullRequest`'s `kind` is ignored.
  - `richText: "markdown" | "adf"`: what the tracker stores. The adapter always takes and gives markdown; this is the panel's `Rich text` row (`ADF, converted` / `Markdown`).
  - `jqlFilter: boolean`: the tracker's events can be narrowed by a query on its side (Jira's admin webhook JQL), shown as a step 3 row. Linear `false`.
- **`readWorkflow(board)`** → `AdapterResult<TrackerWorkflow>`, with `statusGraph`; the base answers `unsupported` without it. `TrackerWorkflow = { readable: boolean; statuses: readonly TrackerStatus[]; transitions: readonly WorkflowTransition[] }`, `WorkflowTransition = { id: string; name: string; from: readonly string[] | "any"; to: string }`. `readable: false` when the credential can't read the graph (Jira without `read:workflow:jira`): the statuses alone, no transitions. For a board whose issue types use several workflows, the union, each transition once per `(from, to, name)`.
- **`routeTo(workflow, fromStatusId, targetStatusId, maxSteps = 3)`** (`tracker/workflow.ts`, pure): the shortest list of transitions from one status to another, a global (`from: "any"`) transition counting as one step from anywhere, or `null`. `reachability(workflow, targetStatusId)` → per status of the workflow: its route's first transition, or `unreachable`. The domain's mapping check and Jira's `moveTicket` both use them.
- **`MoveResult` gains `via: readonly { id: string; name: string }[]`:** the transitions performed, in order; `[]` when nothing moved, and for a tracker that writes statuses directly (Linear). A move no route reaches stays `conflict` (as the Jira fake answers today), with nothing written.
- **The tracker contract suite gains** (`testing/tracker-workflow-cases.ts`, new):
  - `F-008/c5`: `readWorkflow` lists the statuses and transitions, global ones as `any`; a credential without workflow access reads `readable: false` with statuses; `unsupported` without `statusGraph`;
  - `F-008/c5`: a move along a two-step route answers both transitions in `via`; one with no route is `conflict` and leaves the ticket where it was; a second move to the same target writes nothing;
  - `F-152/c3`: two subjects of one adapter on two sites (or workspaces) in one organization: an event signed with one's secret is refused by the other's `verifyWebhook`; a ticket of one isn't readable through the other; a file of one isn't downloadable through the other.
- **The parity test** (`testing/parity.test.ts`) gains rows for `magicWords`, `richText`, `jqlFilter` and `readWorkflow`.

### 5.3 `packages/adapters/adapter-jira` (tickets 03 and 04)

A new Apache-2.0 package, `@ostra/adapter-jira`, beside `adapter-linear`: `JiraAdapter extends TrackerAdapter`, one level deep (ADR 0025), and the connect kit.

**Ticket 03 (in progress, the adapter itself):**
- **The client:** a hand-written REST v3 client on `fetch`, `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…` (or `OSTRA_JIRA_API_URL` in tests), Basic auth `email:token` for the service account's scoped token, a timeout per call, Zod schemas at every response that tolerate unknown fields (`AGENTS.md`), and the per-credential rate budget (named by a digest of the token, as Linear's) honouring `Retry-After`, the burst limits and the per-issue write limit (20 per 2 s, 100 per 30 s). Errors carry Jira's status code and never its body.
- **ADF:** `adfToMarkdown(doc, media)` and `markdownToAdf(markdown)`, hand-written, round-trip tested on the subset ostra and agents write (paragraphs, headings, bullet and ordered lists with nesting, code blocks with their language, block quotes, rules, tables, hard breaks; bold, italic, code, strike and links; mentions as `@name`, `inlineCard` as its URL, `media` through the resolver, panels and expands as block quotes, an unknown node as its text). It may start from the in-memory fake's converter.
- **Intake and paging:** `listTickets` on `POST /rest/api/3/search/jql` with bounded JQL (`project = <id> AND updated >= "<cursor>" ORDER BY updated ASC`, statuses as `status in (…)`), the fields ostra reads, `nextPageToken` until it's absent; `getTicket` by key or stable ID; keys that change on a project move are followed by ID.
- **Transitions:** `moveTicket` through `GET …/issue/{id}/transitions` and `POST …/transitions`, walking a route when no one transition reaches; `updateStatus` refuses a direct write.
- **Webhooks:** `verifyWebhook` checks `X-Hub-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body under the connection's secret, constant-time), takes `X-Atlassian-Webhook-Identifier` as the delivery ID and the timestamp as its time; `parseWebhook` reads `jira:issue_created/updated/deleted` and `comment_created/updated/deleted` into a hint, marking the service account's own changes by `user.accountId`.
- **Comments, links, tickets:** `comment` and `updateComment` in ADF (`updateComment` only on the service account's own), `linkTask` and `linkPullRequest` as remote links upserted by `globalId`, `createTicket` (and `updateTicket`'s description and acceptance criteria), `getUser`, `findUsersByEmail` where the site shows emails.
- **A ticket's files (F-149):** `ticketFiles: "all"`: attachments and ADF `media` nodes, in order, each once; `downloadFile` sends the token only to the site's attachment content URLs on `api.atlassian.com` (or the fake), follows no redirect, and reads no more than `maxBytes`; ostra's own comment's files `byOstra`; `filesInText`.
- **Sub-tasks:** `subIssues: true`; `TicketContext.children` and `parent` from the issue's `subtasks` and `parent`; `createTicket` under a parent.
- **Polling without a public address:** everything above works with `webhooks` unused; polling is `listTickets`.
- **The declared capabilities:** `agentSessions: false`, `agentScopes: []`, `agentSessionLink: false`, `subIssues: true`, `statusGraph: true`, `webhooks: true`, `commentEdit: true`, `attachments: true` (remote links and attachments), `transitions: true`, `mentions: true`, `ticketFields: { acceptanceCriteria: false }` unless a field is configured, `ticketFiles: "all"`, and section 5.2's three once 02 lands.
- **The fake Jira:** an HTTP fake (`packages/adapter-sdk/src/testing/fake-jira/`, in the house style of `fake-linear/`): REST v3 routes the adapter calls, `_edge/tenant_info`, ADF bodies, workflows and transitions with screens that can refuse, attachments, signed webhook deliveries it can send on demand, the per-issue write limit, two sites, and a recording of each request's site and credential digest. The tracker contract suite runs `adapter-jira` against it, and the in-memory fake stays for the suite's own tests.

**Ticket 04 (the connect kit and the workflow):**
- **The connect calls,** exported from `adapter-jira` as `jiraConnect` (`connect.ts`), each taking `{ apiUrl, fetch, timeoutMs }` and its own inputs, and answering `adapter-jira`'s own result types. `packages/api/src/services/jira-connect.ts` (ticket 09) implements the domain's `JiraConnectKit` port (section 5.4) with them, as `services/linear-app.ts` implements `LinearAppKit` with Linear's. The calls: `findSite(siteName)` → `{ cloudId, host, title }` from `https://<site>.atlassian.net/_edge/tenant_info`, or `not-found` (no Jira Cloud answers), `data-center` (the host answers as Jira Server or Data Center, or isn't an `atlassian.net` host) or `unreachable`; `checkToken({ cloudId, email, token })` → the four checks: `GET /myself` (`accountType` `app` is a service account; `atlassian` is a person: `fail`), the project search (`GET /project/search`, none: `fail`), `GET /mypermissions?projectKey=…&permissions=BROWSE_PROJECTS,CREATE_ISSUES,EDIT_ISSUES,TRANSITION_ISSUES,ADD_COMMENTS` per project (short: `warn`, naming the project and the permission), and the workflow search (`GET /workflows/search`, refused: `warn`); 401 or 403 on `/myself` is `refused` with the status code. Each check is `ok | warn | fail` with IDs and names, never Jira's body; `scopes` (the four, choice 5); `webhookEvents` (the six: `jira:issue_created`, `jira:issue_updated`, `jira:issue_deleted`, `comment_created`, `comment_updated`, `comment_deleted`); `suggestedJql(projectKeys)` (`project in (PROJ, SHOP, OPS)`); `webhooksPage(host)`.
- **`readWorkflow`** on `JiraAdapter`: the project's issue types' workflows through `/workflows/search` (statuses with their categories, transitions with `from` and `to`, global ones as `any`), `readable: false` on 403; and `moveTicket`'s `via`.
- **The live test** (`jira-adapter.live.test.ts`, skipped without `OSTRA_JIRA_LIVE_*`, run by ticket 18): the four checks against the maintainer's test site, the workflow read (S-12), a move along a route, and a signed delivery from the real admin webhook through the tunnel.

### 5.4 `packages/domain` (tickets 05 and 06)

**Ticket 05: tracker connections of any kind, boards per connection.**
- **The kinds:** `trackerKinds = ["linear", "jira"] as const`, `TrackerKind`; `comingSoonTrackerKinds = ["trello", "notion"] as const` (the picker's, no adapter). A `TrackerConnection` view is a discriminated union on `kind`, each with `id` (`ConnectionId`), `name`, `site` (Linear's URL key or Jira's host), `state`, `webhookMode`, `lastEventAt`, `failedReason`, `silentSince`, `boards`, `capabilities`; Linear's adds `appUserName`, `agentModeAt`, `accessTokenExpiresAt`; Jira's adds `cloudId`, `accountEmail`, `tokenExpiresOn`, `accessCheck`, `workflowsReadable`, `firstDeliveryAt`, `badSignatureAt`.
- **Lifecycles,** each a union with exhaustive tests, drawn in `domain-model.md`: a connection `pending` → `active` ⇄ `failed` → `revoked` (with `resumedInto`); a board `attached` (its connection active) | `paused` (its connection pending, failed or revoked: `pausedBy: "disconnected" | "failed"`) | `detached`. `boardStateOf(board, connection)` is the one place that derives it; ingest, polling, ticket sync, rules, schedules, prompt tickets and the panel read it.
- **The move away from "the organization's Linear":**
  - `trackerConnectionsOf(db, organizationId)` and `trackerConnectionOf(db, organizationId, connectionId)`; `linearConnectionOf` and every `findFirst({ kind: "linear" })` go (the callers in section 1 change in tickets 07, 09 and 10).
  - `ConnectionTracker` moves from `use-cases/linear-connection.ts` to `use-cases/tracker-connections.ts` and gains `kind` and `name`.
  - `startLinearConnection` always makes a new pending row (a second pending one is allowed), named; `isPendingAppId(appId)` reads `pending` and `pending:<id>`.
  - `attachBoard` takes `{ projectId, connectionId, externalId }` and accepts any active connection of the organization; a board of a non-active connection can't be attached.
  - `setup/timeline.ts`: the step `tracker` replaces `linear` (done on `tracker.connected` or the old `linear.connected`), optional as before; `skipSetupStep({ step: "tracker" })` writes `trackerSkippedAt` and `linearSkippedAt`.
- **Names and uniqueness:** `defaultConnectionName(kind, siteTitle)` (`Globex Jira`, `Acme Linear`); `connectionNameSchema` (1 to 60 characters, trimmed, not blank); a name already used by another connection of the organization not revoked is `name-taken` (case-insensitive). `siteTakenBy(db, organizationId, kind, externalWorkspaceId)` → the connection that holds the site, for the refusals.
- **Resume:** `resumeBoardsInTx(tx, { organizationId, connection })`, called in the transaction that makes a connection `active`: the paused boards of every `revoked` connection of the same kind and `externalWorkspaceId`, with their tickets, move to it; the old rows get `resumedIntoId`; `tracker.resumed` is audited with the boards' count.
- **Jira's mapping:** `draftBoardMapping` already drafts from categories; for a board whose adapter declares `transitions`, `doneBy` defaults to `ostra` (choice 8). `mappingReachability(workflow, mapping)` → per step its `by` line (the first transition and the from-statuses it serves, or `any`) and its `unreachable` from-statuses, from 02's `reachability`. `magicWord` is kept but unused without `magicWords`.
- **Words:** `movedNot` for the progress comment's line when a move found no route ("PROJ-12 stays in Blocked: no transition in its workflow reaches In Review."), and the paused board's line.
- **Audit actions:** `tracker.connection-created`, `tracker.renamed`, `tracker.site-found`, `tracker.token-saved`, `tracker.connected`, `tracker.secret-rotated`, `tracker.token-replaced`, `tracker.disconnected`, `tracker.resumed` (IDs only).
- **Glossary and domain model:** tracker connection, paused board, target status.

**Ticket 06: connecting Jira, and a connection's changes.**
- **The port:** `JiraConnectKit` (`findSite`, `checkToken`, `scopes`, `webhookEvents`, `suggestedJql`, `webhooksPage`, as 5.3 lists, with the domain's own result unions), injected like `LinearAppKit`; a fake kit in `domain/testing/`.
- **Use cases,** admin only, each a transaction where it writes, each audited:
  - `startTrackerConnection({ kind, name })` → a pending connection (Linear's delegates to `startLinearConnection`);
  - `findJiraSite({ connectionId, site, name })` → trims a pasted URL to the name; refuses `site-taken` (naming the holder), `data-center`, `not-found`; sets `appId` and the workspace columns; a changed site clears steps 2 and 3;
  - `checkJiraToken({ connectionId, email, token, expiresOn })` → the checks; nothing stored;
  - `saveJiraToken(…)` → runs the checks again, refuses on a `fail`, stores the token (`purpose: "jira-token"`), the email, the date, `accessCheck`, `scopes`, `workflowsReadable`;
  - `jiraWebhookOf({ connectionId })` → makes the secret once while pending (`purpose: "jira-webhook-secret"`), and answers it only while `firstDeliveryAt` is null;
  - `finishJiraPolling({ connectionId })` → `active` in polling mode with no secret, when the install has no public address;
  - `activateOnFirstDelivery(tx, connection)` → called by core's inbox on a pending Jira connection's first valid delivery (07);
  - `rotateJiraSecret`, `replaceJiraToken` (the read-back first), `recheckJiraToken` (with the saved token), `renameConnection`, `disconnectTracker` (Jira's and Linear's, Linear's through `disconnectLinear`), and `failConnection(tx, id, reason)` for an expired or refused token.
  - `tokenExpiryState(connection, now)` → `healthy | expires-soon (days) | expired`, at 14 days *(working value)*.
- **Settings** (`settings.ts`, with their lines in `docs/configuration.md`): section 5.5.

### 5.5 Settings

| Setting | Default |
|---|---|
| `OSTRA_JIRA_API_URL` (server) | empty: Jira's own (`https://api.atlassian.com` and each site's `https://<site>.atlassian.net/_edge/tenant_info`). Set it only to the fake Jira in tests: the gateway and the site lookup then both go to it |

Nothing else is new: polling reads `OSTRA_TRACKER_POLL_SECONDS` for every kind, and webhooks or polling follow `OSTRA_CORE_PUBLIC_URL` as for Linear. The expiry warning's 14 days and the backstop's 5 minutes are working values in code. A fresh install with only the required settings connects Jira by webhook or polling.

---

## 6. Parity

### Adapter parity

| Feature | What it asks | Linear | Jira | The fakes |
|---|---|---|---|---|
| F-152: several connections, kept apart | nothing new of the adapter: one adapter per connection | yes | yes | two sites of the in-memory Jira fake, two workspaces of the fake Linear, two sites of the HTTP fake Jira |
| F-008/F-007: moving a ticket | `moveTicket` (`transitions` says how), `via` | direct, `via: []` | by transitions, `via` named | the in-memory fake walks; the tiny adapter writes directly |
| F-008: the mapping's transition lines | `statusGraph`, `readWorkflow` | — (no row drawn) | yes, `readable` per token | the in-memory fake; the HTTP fake with and without workflow access |
| F-008: the magic word | `magicWords` | yes | — (no row drawn) | the tiny adapter `false` |
| F-008: the JQL row in step 3 | `jqlFilter` | — | yes | — |
| F-012: agent mode | `agentSessions` | yes | — (`Agent mode – not in Jira` in the panel's list, nothing else) | the fake Linear |
| F-077: sub-issues | `subIssues` | sub-issues | sub-tasks | both fakes |
| F-149: a ticket's files | `ticketFiles` | `all` | `all` | the in-memory fake `all`; the tiny adapter `none` |
| F-042: polling | `listTickets` with `updatedSince` | yes | yes (`/search/jql`) | every fake |

The parity test (`packages/adapter-sdk/src/testing/parity.test.ts`) gains a row for each new capability. The panel reads capabilities from the connection's adapter (`trackers.list`'s `capabilities`), never from its kind, except for words (`Sub-tasks` and `Sub-issues`, `Jira` and `Linear`).

### Runner parity

Nothing in milestone 11 reaches a runner. A Jira ticket's files reach the box as milestone 9's do, as blobs on the bulk path, on every executor; the protocol doesn't change. The executor suite isn't touched.

---

## 7. Packages, licenses and owners

| Package | License | New in M11 | Built by |
|---|---|---|---|
| `packages/adapter-sdk` | Apache-2.0 | `readWorkflow`, `routeTo`, `reachability`, `MoveResult.via`, three capabilities; the suite's workflow and two-site cases; the HTTP fake Jira | adapters (02), the Jira agent (03) |
| `packages/adapters/adapter-jira` (new) | Apache-2.0 | the adapter, the client, ADF, the connect kit | the Jira agent (03), adapters (04) |
| `packages/adapters/adapter-linear` | Apache-2.0 | the three capabilities, `via: []` | adapters (02) |
| `packages/db` | Sustainable Use | the M11 migration | core (01) |
| `packages/domain` | Sustainable Use | connections of any kind, paused boards, resume, names, the mapping's reachability, the Jira connect use cases, the expiry, the setup step | core (05, 06) |
| `apps/core` | Sustainable Use | `/webhooks/jira/:id`, first delivery, Jira's processing, polling every kind, the backstop, the expiry job, Jira in ticket sync and context | core (07, 08) |
| `packages/api` | Sustainable Use | `trackers.*`, `trackers.jira.*`, `trackers.linear.*`, boards from any connection, the ticket's connection in every payload | api (09, 10) |
| `apps/web` | Sustainable Use | the marks, Trackers, a connection's page, Jira's steps, Boards, Home's step, the chips; the routes and the redirect | web (11 to 16) |
| `apps/docs` | Apache-2.0 | the Trackers and Jira pages, Linear's re-homed | core (17) |
| `e2e/m11-trackers-jira` (new) | Sustainable Use | the demo | core (18) |

The license line holds (ADR 0045, ADR 0048): `adapter-jira` imports only `@ostra/adapter-sdk`, `@ostra/protocol` and `zod`; no Apache-2.0 package depends on a Sustainable Use one. The domain's `JiraConnectKit` port is implemented in `packages/api/src/services/jira-connect.ts` on `adapter-jira`'s connect calls, as `LinearAppKit` is in `services/linear-app.ts`, and wired in the API's composition root (`runtime.ts`); core builds `JiraAdapter` in `tracker/connections.ts`. `pnpm check:licenses` runs on every commit.

---

## 8. The builders and their tickets

Six builders: **core**, **api**, **web**, **adapters**, the **Jira agent** (ticket 03, started on 2026-11-23 on the maintainer's "start building immediately") and the **maintainer** (19). The contracts land first (01, 02, 05); ticket 03 runs beside them. The web tickets are split so they run in parallel once the API lands, and ticket 11 (the marks) needs nothing.

| # | Ticket | Builder | Blocked by | Visual |
|---|---|---|---|---|
| 01 | DB: the milestone 11 migration | core | none | no |
| 02 | Adapter SDK: the workflow, the move's route and the declared words | adapters | none | no |
| 03 | Jira adapter: the client, ADF, intake, transitions, webhooks, files, sub-tasks, polling and the fake Jira (in progress) | the Jira agent | none | no |
| 04 | Jira adapter: the site, the token's read-back and the workflow | adapters | 02, 03 | no |
| 05 | Domain: tracker connections of any kind, boards per connection | core | 01, 02 | no |
| 06 | Domain: connecting Jira, and a connection's changes | core | 05 | no |
| 07 | Core: Jira's webhook and polling, routed by connection | core | 03, 05, 06 | no |
| 08 | Core: ticket sync, context and writes on a Jira board | core | 03, 05, 07 | no |
| 09 | API: tracker connections and connecting Jira | api | 04, 06 | no |
| 10 | API: boards from any connection, and the ticket's tracker everywhere | api | 02, 05, 09 | no |
| 11 | Web: the tracker marks | web | none | yes |
| 12 | Web: Organization › Trackers | web | 09, 11 | yes |
| 13 | Web: connecting Jira | web | 09, 11 | yes |
| 14 | Web: a connection's settings, Jira's and Linear's | web | 09, 11 | yes |
| 15 | Web: a project's Boards from any tracker | web | 10, 11 | yes |
| 16 | Web: Home's tracker step and the ticket chips | web | 09, 10, 11 | yes |
| 17 | Docs: Trackers and Jira | core | 09, 10 | no |
| 18 | The end-to-end demo and the ledger (at the launch gate) | core (lead) | 01 to 17; the maintainer's word for the launch gate; 19's test site | no |
| 19 | The maintainer's steps outside the code | maintainer | none for the test site; 18 for the review of the run | no |

**Who starts when.**
- **core** takes 01 at once, then 05 and 06, then 07 and 08 as 03 lands.
- **adapters** take 02 at once, and 04 once 02 and 03 are in.
- **the Jira agent** carries on with 03, rebasing on 02 when it lands (02's comments say which methods 03 must implement then).
- **api** builds 09 once 04's kit and 06 are in, then 10.
- **web** takes 11 at once, builds 12 to 16's components and stories against the targets meanwhile, and wires each to its procedures as 09 and 10 land.

Milestone 10's remaining tickets touch `apps/web`'s task page; ticket 16 meets them in `task-ticket.tsx` and the thread's meta line, and waits for an open one on the same file, saying so in its `## Comments`. The launch gate's tickets stay held, and run after milestone 11.

---

## 9. Test seams

Agreed here so builders don't each invent one.

- **Postgres:** milestone 1's helper, a database per test file. Every test that reads connections or boards also checks that another organization's rows stay invisible, and every multi-connection test holds two connections of one kind in one organization, so a `findFirst` by kind fails it.
- **Jira:** two fakes. The in-memory `JiraFakeAdapter` (`testing/jira-fake.ts`) for the domain's and core's unit tests, where a `TrackerAdapter` is enough; the HTTP fake Jira (`testing/fake-jira/`, ticket 03) for `adapter-jira`'s own tests, the API's connect steps (through the kit), core's webhook and polling tests, the browser specs and the demo. The HTTP fake signs deliveries with a connection's secret on demand, and with a wrong one.
- **Linear:** the fake Linear (`testing/fake-linear/`) gains a second workspace, so two Linear connections run in one test.
- **The connect kit:** a fake `JiraConnectKit` in `domain/testing/` with each check's outcomes, for the use cases' tests.
- **Time:** the expiry job, the 14 days, the silent webhooks' 30 minutes and the backstop read the `Clock` port.
- **Text that is data:** every test of a ticket's ADF, a comment or a connection's name holds shell syntax, prompt-like text, an ADF node of an unknown type and a 64 KiB body, and asserts none reaches a log line or a shell command.
- **The marks:** a component test renders each mark in both treatments and both themes, and checks each has its label or is `aria-hidden` beside a word.

---

## 10. Every ticket's checks and commit

As milestones 1 to 10 (`../m9-attachments/spec.md`, section 10), and the lead's rules (`C:/Users/santi/ow/_lead/AGENT-RULES.md`). In short:
- **Checks once, then push.** `pnpm typecheck`, `pnpm lint` and `pnpm test` for the touched packages (and their direct consumers when a shared type changes), with `--cache-dir=C:/Users/santi/ow/.turbo-cache`, once before each push. `pnpm check:licenses` passes. GitHub CI runs the rest; a failure from the change is fixed forward.
- **The whole-repo checks** run for tickets that touch the schema, credentials or a tracker's untrusted input: 01, 03, 04, 05, 06, 07 and 09.
- **Browser specs run once,** at the milestone's end (ticket 18). A fix that needs browser proof runs only its own spec file.
- **A ticket's "(break-it: ...)"** names what its test must catch, and nothing more: no break-it pass runs (the maintainer, 2026-11-21).
- **The new setting** has its working default and its line in `docs/configuration.md`. A fresh install with only the required settings connects Linear or Jira.
- **Proof:** each condition of a row's "done when" has a test named with its key (`it("F-008/c3: ...")`) that exercises it through the real code path, and CI runs it. No proof file. A condition only a live run shows waits for the launch-gate Proof run, or here for the manual run on the maintainer's test site.
- **No secret in the commit,** and no token, webhook secret or ticket text in a log line.
- **Dependencies:** none (section 11).
- **Stage only the ticket's own paths,** no `git add -A`, no stash. A gitmoji message of at most 50 characters, no AI attribution. Rebase onto `origin/main`, then push to `origin main`.
- **Work in a worktree** under `C:/Users/santi/ow/<name>` from `origin/main`, never in `c:/Users/santi/ostra`. Kill every process started with its whole tree, and remove the worktree at the end.
- The ticket file gets its `Status:` updated and a line under `## Comments` with the commit's hash.

### 10.1 How each row gets proved

A condition's key is its sentence's place in the row's "done when" (`features.md`), as before.

**F-152 Trackers:**
- c1: several connections of any kind, each named with its own credentials and webhook, on one Trackers page; `/organization/linear` redirects (01, 05, 09, 12, 14)
- c2: one connection per site or workspace, a second refused naming the first (01, 05, 06, 09, 13)
- c3: a client's tickets move only through their own connection; members never see a webhook URL or secret (02, 05, 07, 09, 12, 14)
- c4: Boards attach from any active connection, several at once, each with its mark and connection's name; every ticket names its tracker with its mark (01, 05, 10, 15, 16)
- c5: disconnect stops events, deletes credentials, pauses boards read-only; the same site again resumes them (05, 06, 07, 09, 15)
- c6: Linear's connection becomes the first named one on upgrade, nothing lost; the migration adds and relaxes only (01, 05)
- c7: Home's step "Connect a tracker", either kind, skippable, done on any active connection; skipped stays skipped (05, 09, 16)
- c8: Trello and Notion "Coming soon" in the picker, disabled (11, 12)

**F-008 Jira:**
- c1: the three steps, each checked: the site's cloud ID, the token's read-back before it's saved, the webhook connected by its first signed delivery; or polling (04, 06, 07, 09, 13)
- c2: every call through the gateway with the stored token, which reaches no box, log or member (03, 04, 06, 09)
- c3: deliveries verified by HMAC, stored once per identifier, answered at once, the ticket fetched first; the service account's echoes skipped (03, 07)
- c4: polling by `/search/jql` and `nextPageToken` within 60 s; the 5-minute backstop (03, 07)
- c5: a target status per step; moves by the transition that reaches it, never a status write; none reaches: stays put and the comment says so; the transition lines and warnings when workflows read (02, 03, 04, 05, 08, 10, 15)
- c6: a Jira ticket reads as a Linear one: ADF to markdown, sub-tasks, files; ostra's comment in ADF, edited in place; remote links once (03, 08, 16)
- c7: intake rules, schedules, Create ticket, prompt tickets, reopen and sync on a Jira board; Done by ostra by default, or by Jira automation (05, 08, 15)
- c8: the expiry's warning and failure; Replace and Rotate (06, 07, 09, 13, 14)
- c9: the tracker contract suite passes for `adapter-jira` against the fake Jira; no agent sessions declared, agent mode not offered (03, 04, 09, 14)
- c10: the live run on a real Jira Cloud site, ticket to merged PR, moved by transitions (18, after 19) — **needs** the maintainer's test site

---

## 11. Dependencies

**None.** Jira's client is hand-written on `fetch` with Zod schemas, as Linear's GraphQL client is, and the ADF converter is hand-written for the subset ostra and agents write, as the in-memory fake's already is. Both are enough.

**Considered and not added:**
- `jira.js` 6.4.0 (MIT): a full typed client, with `verifyWebhookSignature`. It covers far more than ostra calls (about fifteen endpoints), brings its own HTTP layer and auth helpers, and has no ADF helpers (research §2.8). A hand-written client keeps the calls, the errors and the rate budget in ostra's own shape.
- `@atlaskit/adf-utils` (Apache-2.0) and `@atlaskit/editor-markdown-transformer` (MIT): frontend editor packages with large trees; whether the markdown transformer serializes cleanly in Node is unverified (research §2.8).

**A question for the maintainer** (Q353, open, nothing waits on it): markdown to ADF is the one place a library would really help, because agents write full GitHub-flavoured markdown (nested lists, tables, emphasis edge cases). `mdast-util-from-markdown` 2.1.0, `micromark-extension-gfm` 3.0.0 and `mdast-util-gfm` 3.1.0 (all MIT) are already in the lockfile through `apps/docs`; adding them to `adapter-jira` would parse markdown exactly as CommonMark and GFM do, and the converter would walk the tree. The spec's default is hand-written; ticket 03 builds that, and switches only on the maintainer's yes.

---

## 12. Choices this spec makes

The fifteen choices of the targets' README are the maintainer's, settled as recommended on 2026-11-23 ("yes to all"):
1. Trello and Notion in the picker, disabled, `Coming soon`. 2. A connection has a name. 3. One site or workspace, one connection. 4. Polling-only Jira is allowed. 5. Four scopes, the fourth for workflows. 6. The admin gives the token's expiry date. 7. A target status per step; the adapter picks the transition. 8. Done moved by ostra by default for Jira. 9. Brand colour where a mark names a tracker once, one colour where it repeats. 10. Inbox rows always show the mark. 11. Agent mode is a Linear-only section. 12. Disconnecting pauses boards; reconnecting resumes them. 13. A connection's detail in the list's panel, its page at `/organization/trackers/<id>`. 14. The setup step's one button goes to Trackers. 15. ostra makes the webhook secret and shows it until the first delivery, then only Rotate.

**The lead's calls,** each recorded in `context/open-questions.md`'s settled list and in ADR 0071 (the maintainer can change any; a change moves it back to the open list, and the ticket that holds it changes):

16. **How a reconnect resumes** (Q348). The paused boards and their tickets move to the new connection in the transaction that activates it; the old row stays with `resumedIntoId`. Reviving the old row can't work for Linear, whose new app's webhook names the new row.
17. **Where one-per-site holds** (Q349). Per organization, among connections not revoked, in Postgres; not install-wide.
18. **The migration's two drops** (Q350). The one-Linear index and `Board`'s `(projectId, externalId)` key are dropped in the same migration that adds their replacements: constraints, not data, so outside "add first; drop later". `linearSkippedAt` stays one release.
19. **A delivery to a revoked connection** (Q351). `410 Gone`, stored nowhere, so Jira stops retrying it, and the admin is told to delete the webhook.
20. **A move with no single transition** (Q352). The shortest route of at most three transitions; more than three, or none, is "stays put", said in the comment.
21. **Markdown to ADF** (Q353, open). Hand-written unless the maintainer allows the three `mdast`/`micromark` packages (section 11).

---

## 13. Screens and their targets

`build-order.md`: a milestone's screens are designed first, image first. **The targets are approved** (2026-11-23, "yes to all") in `context/brand/app-targets/m11-trackers/`, each with its pictures, its build spec and its HTML source. The build spec wins on copy, states and behaviour; the picture wins on size, spacing and contrast, and here a picture is HTML, so its sizes are exact CSS px. Each web ticket compares its screens with the targets at 1440 and 390 px in both themes, and records the screenshots under its `## Comments`.

| Target (in `app-targets/m11-trackers/`) | Screen | Feature | Ticket |
|---|---|---|---|
| `README.md` "The marks", `html/logos/` | The four marks, brand and one colour | F-152 | 11 |
| `trackers.md` (`trackers`, `trackers-picker`, `trackers-empty`, `trackers-states`, `trackers-phone`) | Organization › Trackers: the list and its panel, the picker, the empty state, every state, the phone | F-152, F-008 | 12 |
| `jira-connect.md` (`jira-connect`, `-webhook`, `-polling`, `-states`, `-phone`) | Connecting Jira: the three steps, polling, each failure, the phone | F-008 | 13 |
| `connection-settings.md` (`connection-jira`, `connection-linear`) | A connection's page once connected: Jira's, and Linear's re-homed | F-152, F-008, F-005, F-012 | 14 |
| `boards-mixed.md` (`boards-mixed`, `boards-attach`, `boards-states`, `boards-phone`) | A project's Boards with a Linear team and a Jira project; the attach picker; paused and failed boards; Jira's mapping | F-152, F-008, F-007 | 15 |
| `setup-checklist.md` (`setup-checklist`) | Home's step 4 | F-152, F-076 | 16 |
| `ticket-chips.md` (`ticket-chips`) | Every place a ticket shows, with its mark | F-152, F-008 | 16 |

**Screens that only grow,** built against their existing targets with the changes listed in the building ticket's `## Comments`:
- The new project's tracker choice (`app-targets/m2/project-new`): a board from any connection, grouped as the attach picker groups them (15).
- The task page's ticket card and "On Linear" group (`app-targets/m2/task-ticket`): "On Jira", the transitions' names (16).
