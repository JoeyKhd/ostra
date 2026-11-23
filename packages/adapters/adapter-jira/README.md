# @ostra/adapter-jira

The Jira Cloud tracker adapter (ADR 0013, ADR 0047, F-008): Jira's REST v3 over `fetch`, with no client library and no new dependency. Apache-2.0. Jira Data Center, Connect and the Rovo agent connector are out of scope (`context/research/trackers.md` §2).

- `JiraAdapter` extends `TrackerAdapter` (`name: "jira"`) and passes the tracker contract suite on the fake Jira. It signs in as a service account the organization owns, with its scoped API token (Basic `email:token`). Given the site's cloud ID, calls go through Atlassian's gateway (`api.atlassian.com/ex/jira/{cloudId}`), which a scoped token needs. Without one, calls go to the site, for a classic token. The cloud ID comes from `jiraConnect.findSite` (below).
- **Capabilities:**
  - `transitions`, `statusGraph`, `subIssues`, `webhooks`, `commentEdit`, `attachments` and `mentions` are true.
  - `agentSessions` is false, so `agentScopes` is empty and `agentSessionLink` is false.
  - `ticketFiles` is `all`.
  - `ticketFields.acceptanceCriteria` is true only when the connection names a paragraph custom field (`acceptanceCriteriaField`). Jira has no criteria field of its own.
  - `JIRA_CAPABILITIES` is the declaration without that field.
- **Connecting a site** (`jiraConnect`, in `connect.ts`; `context/brand/app-targets/m11-trackers/jira-connect.md`): the calls the connect steps make before anything is saved. Each takes `{ apiUrl, fetch, timeoutMs }` and answers this package's own types; the API's `services/jira-connect.ts` (ticket 09) turns them into the domain's `JiraConnectKit`. With `apiUrl` (`OSTRA_JIRA_API_URL`, the fake Jira), the gateway and every site lookup go there, the site named in `X-Forwarded-Host`.
  - `findSite(options, siteName)` is step 1. It takes a name (`globex`), a host or a pasted URL, and reads the site's public `/_edge/tenant_info` with no credential. It answers `found` (the cloud ID, the host, and a title made from the name, `Globex`), `not-found`, `data-center` or `unreachable`. Without `apiUrl`, a host that isn't `<name>.atlassian.net` is `data-center` with no call: ostra asks no other host. A site without tenant info is asked its `/rest/api/2/serverInfo`, whose `deploymentType` names Jira Server and Data Center.
  - `checkToken(options, { cloudId, email, token })` is step 2, through the gateway, read-only. Four checks, each `ok`, `warn` or `fail` with IDs and names:
    - who the token signs in as (`/myself`): a service account (`accountType: "app"`) is `ok`, a person's account `fail`, and an account Jira doesn't type `warn`;
    - the projects it sees (`/project/search`, paged): none is `fail`;
    - the five permissions in each (`/mypermissions`, `JIRA_CONNECT_PERMISSIONS`: browse, create, edit, transition, comment): a project short of one is `warn`, naming it and what it lacks;
    - whether it reads each project's workflows (`/workflows/search`): refused, or shown none, is `warn`, naming the projects.
  - It also answers the scopes it needs (`JIRA_TOKEN_SCOPES`: `read:jira-work`, `write:jira-work`, `read:jira-user`, `read:workflow:jira`), each `confirmed` by a read, `refused`, or `unchecked` (`write:jira-work`: nothing is written before the token saves). A 401 or 403 on `/myself` is `refused` with that status; Jira failing is `unreachable`.
  - The token is held in one local and sent in the Basic header alone. No answer holds it, and Jira's error bodies are never read.
  - `scopes`, `webhookEvents` (the six), `suggestedJql(projectKeys)` (`project in (PROJ, SHOP)`) and `webhooksPage(host)` (Settings › System › WebHooks) are step 3's words.
- **Boards and statuses:** a board is a Jira project (`listBoards`, paged). `listStatuses` lists the project's statuses across its issue types, by category. Jira's `new`, `indeterminate` and `done` read as `open`, `started` and `done`, and a done status named like "Won't do" reads as `cancelled`.
- **Moves walk the workflow.** `moveTicket` never writes a status, and `updateStatus` is `unsupported`. A move takes the issue's available transitions one call at a time, at most three of them (`MAX_ROUTE_STEPS`, Q352). It never passes through a done or cancelled status it wasn't asked for. It answers the transitions it took, in order, in `MoveResult.via`, for the task's "On Jira" rows.
  - With `read:workflow:jira`, the adapter reads the ticket's own issue type's workflow (`POST /rest/api/3/workflows` by the project and issue type, kept 5 minutes) and takes the shortest route, `routeTo` from `@ostra/adapter-sdk`. A target no route reaches is `conflict`, refused before any step, and the ticket stays where it was.
  - Without that scope, it steps toward the target's category and never away from it. Out of a done status, it reopens first.
  - A transition whose screen needs a field ostra doesn't fill is refused by Jira (400), and the walk routes around it.
  - `readWorkflow(board)` is the tracker contract's (`TrackerWorkflow`, from `@ostra/adapter-sdk`), read through `/rest/api/3/workflows/search?projectId=…`: the board's statuses with their categories, and the transitions of every workflow its issue types use, in one, each once per `(from, to, name)`, a global one from `any`. The workflows API names statuses by a reference, which its answer maps to their IDs. Without the scope, or when Jira shows the token none of the project's workflows, it's `readable: false`, with the statuses alone. The domain's mapping check reads it with `reachability` from `@ostra/adapter-sdk`.
  - Jira's classic `workflow/search` and `workflowscheme/project` aren't read: Atlassian removed the classic `workflow/search` on 2026-06-01 (changelog CHANGE-2569), and the workflows API answers for company-managed and team-managed projects alike.
- **Reading tickets:** everything is keyed on the issue's numeric ID, since a key changes when the issue moves project.
  - `getTicketContext` reads the description and comments from ADF to markdown, plus labels, priority, the parent, sub-tasks and an epic's children (`parent = …` in JQL), issue links both ways, remote links and attachments.
  - It lists each file once, in order: an upload's `media` node (found by its name among the issue's attachments), a link to an attachment, then the attachments.
  - A remote link stays a link.
- **Polling and intake:**
  - `listTickets` searches with `/rest/api/3/search/jql` and pages with `nextPageToken`. With `updatedSince`, it asks JQL for the minute in the service account's own time zone and keeps only what changed at or after the exact time.
  - `searchTickets(board, jql)` runs an intake rule's JQL. The JQL is bounded to the board's project, its own `ORDER BY` is dropped, and the oldest change comes first. It's Jira only: core reaches it through this class, never the shared interface.
- **Writes:**
  - Comments and descriptions go from markdown to ADF (`markdownToAdf`, in `adf.ts`). The markdown can hold headings, lists, code, quotes, rules, tables, links, `[~accountid:…]` mentions and images. An image on the site's file host is written as a link to it.
  - `updateComment` edits only the service account's own comment, even where its permissions would allow a person's.
  - `linkTask` and `linkPullRequest` make remote links, upserted by a `globalId` made from the URL, so a retry links once.
  - `createTicket` makes a task, a sub-task under a task, or a task under an epic.
  - `attachFile` uploads with `X-Atlassian-Token: no-check` and keeps its marker in ostra's issue property `ostra.attachments`, since Jira's attachments have no subtitle. `listAttachments` reads the marker back.
- **Files:**
  - `downloadFile` takes only the site's own attachment URLs (the API's `attachment/content/{id}`, at the gateway or the site, or the site's `/secure/attachment/{id}/…`). It fetches `?redirect=false`, never follows a redirect, and stops reading past `maxBytes`.
  - `filesInText` reads a follow-up's markdown the same way.
- **People:** `findUsersByEmail` searches `user/search` and counts a user only when Jira shows the token their address and it's the one asked. A hidden address is left out, never guessed. A mention is `[~accountid:<id>]`, which the ADF writer turns into a mention node. `getUser` reads a person by account ID.
- **The admin webhook:** `verifyJiraWebhook` (`verifyWebhook`) checks `X-Hub-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body with the shared secret, in constant time, and reads `X-Atlassian-Webhook-Identifier`.
  - A method other than `sha256` is refused.
  - A delivery whose body `timestamp` is over `JIRA_WEBHOOK_MAX_AGE_MS` (20 min) from now is stale. That window covers Jira's secondary flow (up to 15 min); later retries are refused, and the reconcile poll picks the change up.
  - A replay repeats the signature, which core's inbox claims once per connection.
  - `jiraWebhookHint` (`parseWebhook`) reads the six events in `JIRA_WEBHOOK_EVENTS` into a hint. It marks ostra's own change by the event's `user` or the comment's author.
  - `webhookJql(keys)` gives the optional filter.
- **Rate limits:** a 429 is `rate-limited`, with the wait from `Retry-After`, or else from `X-RateLimit-Reset`. The per-credential budget reads `X-RateLimit-Remaining` and `X-RateLimit-Reset`, and waits without calling once nothing is left. API-token traffic is exempt from Jira's points quota, but the burst and per-issue write limits still apply. The writes keep the per-issue limits themselves (20 in 2 s, 100 in 30 s): one past them answers `rate-limited` without a call.
- **No content in logs or errors:** log lines carry IDs, operation names, status codes and counts, never a token, an email or ticket text. Jira's error bodies can quote ticket text, so they're never read into a message.

The tests run against the fake Jira, `createFakeJira()` in `@ostra/adapter-sdk/testing` (`packages/adapter-sdk/src/testing/fake-jira/`, where core's, the API's and the browser specs' tests reach it too). It's one in-process HTTP server that answers Jira's own paths and JSON shapes, the way the fake Linear does.

- **Sign-in and permissions:**
  - It serves the site, the gateway (`/ex/jira/{cloudId}/…`), `/_edge/tenant_info` and the server info. Asked with `X-Forwarded-Host`, it stands for that host: its own site (`siteHost`, `globex.atlassian.net`), a Data Center server (`dataCenterHost`), or no site at all.
  - It has accounts with Basic `email:token` sign-in. A scoped token's scopes are checked per route, a scoped token answers only at the gateway and a classic one only at the site, and a missing scope is 401.
  - It keeps project permissions per account (`revokePermissions`; `VIEW_READONLY_WORKFLOW` hides a project's workflows), and refuses a token on request (`refuseToken`, 401 or 403).
  - It records each request's route, whether it came to the gateway or the site, and a digest of its token (`calls()`).
- **Projects and workflows:** projects with Task, Bug, Epic and Sub-task types, seven statuses in Jira's three categories, and a workflow whose transitions are the only way to change a status. The workflow has a global "Won't do", Blocked, no way back to Backlog, and a "Close" whose screen refuses a call without a resolution. An issue type can have a workflow of its own (`useWorkflow`). The workflows API answers `/workflows/search` and the bulk read by project and issue type, with status references that aren't the statuses' IDs.
- **Issues:** issues with ADF descriptions and comments, keys that change on a move (the old key still finds the issue), issue links, multipart attachments, remote links upserted by `globalId`, and issue properties.
- **Search:** JQL with `AND`, `OR`, `NOT`, `IN`, `IS EMPTY` and `ORDER BY`, paged by `nextPageToken`, with times read in the asking account's time zone. Unbounded or unknown JQL is a 400.
- **People:** user search by name or address, with addresses a person may hide.
- **Webhooks:** admin-webhook deliveries, signed with the connection's secret or a wrong one.
- **Rate limits:** a 429 on request, with or without `Retry-After`, and Jira's per-issue write limit.

`fakeJiraSuiteFixture` sets it up for `defineTrackerContractSuite`. The fake's assumptions are listed at the top of `fake-jira.ts`.

**Not proved here, and waiting for a real Jira Cloud site:**

- that a scoped token reaches attachment content through the gateway;
- S-12: whether a service account's scoped token with `read:workflow:jira` reads `/workflows/search` and `POST /workflows`, on a company-managed and a team-managed project. Atlassian's docs ask for Administer Jira, or a project's Administer projects or View (read-only) workflow permission. Whether Jira refuses without them, or answers an empty page (both read as `readable: false`), and whether the workflows API's transition IDs are the ones an issue's transitions carry. The live test prints what it finds;
- S-10: whether the token is a service account's (`accountType: "app"`), or the bot user ADR 0047 falls back to;
- what a site that doesn't exist answers at `/_edge/tenant_info` (a 404, a redirect or another page: each reads as `not-found`);
- that an upload's `media` node carries the file's name as `alt`, which is how the adapter finds its attachment;
- that a webhook retry keeps the first delivery's body and `timestamp`;
- that JQL reads absolute times in the asking account's time zone;
- whether `user/search` shows a service account people's addresses;
- how a team-managed project's workflow reads (a project-scoped workflow in the workflows API). Where it can't be read, a move finds its transitions per ticket.

`jira-adapter.live.test.ts` runs the read-back, each project's workflow read and one move along a route on a throwaway issue it deletes after, against the maintainer's test site. It skips without `OSTRA_JIRA_LIVE_SITE`, `OSTRA_JIRA_LIVE_EMAIL` and `OSTRA_JIRA_LIVE_TOKEN` (`~/.config/ostra-dev/jira.env`), so CI never runs it; ticket 18 does.
