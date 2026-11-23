# @ostra/adapter-jira

The Jira Cloud tracker adapter (ADR 0013, ADR 0047, F-008): Jira's REST v3 over `fetch`, with no client library and no new dependency. Apache-2.0. Jira Data Center, Connect and the Rovo agent connector are out of scope (`context/research/trackers.md` §2).

- `JiraAdapter` extends `TrackerAdapter` (`name: "jira"`) and passes the tracker contract suite on the fake Jira. It signs in as a service account the organization owns, with its scoped API token (Basic `email:token`). Given the site's cloud ID, calls go through Atlassian's gateway (`api.atlassian.com/ex/jira/{cloudId}`), which a scoped token needs. Without one, calls go to the site, for a classic token. `findJiraCloudId(siteUrl)` reads the cloud ID from the site's public `/_edge/tenant_info`.
- **Capabilities:**
  - `transitions`, `statusGraph`, `subIssues`, `webhooks`, `commentEdit`, `attachments` and `mentions` are true.
  - `agentSessions` is false, so `agentScopes` is empty and `agentSessionLink` is false.
  - `ticketFiles` is `all`.
  - `ticketFields.acceptanceCriteria` is true only when the connection names a paragraph custom field (`acceptanceCriteriaField`). Jira has no criteria field of its own.
  - `JIRA_CAPABILITIES` is the declaration without that field.
- **The token's read-back:** `checkToken()` is step 2 of connecting (`context/brand/app-targets/m11-trackers/jira-connect.md`). It reports:
  - who the token signs in as (`/myself`; `accountType: "app"` is a service account);
  - every project it sees, with the permissions it lacks there (`/mypermissions`, `JIRA_PROJECT_PERMISSIONS`);
  - whether it reads workflows.
  The scopes it needs are `JIRA_TOKEN_SCOPES`: `read:jira-work`, `write:jira-work`, `read:jira-user` and `read:workflow:jira`.
- **Boards and statuses:** a board is a Jira project (`listBoards`, paged). `listStatuses` lists the project's statuses across its issue types, by category. Jira's `new`, `indeterminate` and `done` read as `open`, `started` and `done`, and a done status named like "Won't do" reads as `cancelled`.
- **Moves walk the workflow.** `moveTicket` and `updateStatus` never write a status. They take the issue's available transitions one call at a time, and never pass through a done or cancelled status they weren't asked for.
  - With `read:workflow:jira`, the adapter reads the workflow (scheme, then `workflow/search`) and takes the shortest way there. A target no walk reaches is `conflict`, and the ticket stays where it was.
  - Without that scope, it steps toward the target's category and never away from it.
  - `readWorkflow(board)` gives each issue type's graph. `planMapping(graph, mapping)` gives the Boards page its `by …` lines and its warnings: per step, the transitions into the target, the way from every status, and the statuses no walk leaves.
- **Reading tickets:** everything is keyed on the issue's numeric ID, since a key changes when the issue moves project.
  - `getTicketContext` reads the description and comments from ADF to markdown, plus labels, priority, the parent, sub-tasks and an epic's children (`parent = …` in JQL), issue links both ways, remote links and attachments.
  - It lists each file once, in order: an upload's `media` node (found by its name among the issue's attachments), a link to an attachment, then the attachments.
  - A remote link stays a link.
- **Polling and intake:**
  - `listTickets` searches with `/rest/api/3/search/jql` and pages with `nextPageToken`. With `updatedSince`, it asks JQL for the minute in the service account's own time zone and keeps only what changed at or after the exact time.
  - `searchTickets(board, jql)` runs an intake rule's JQL. The JQL is bounded to the board's project, its own `ORDER BY` is dropped, and the oldest change comes first. It's Jira only: core reaches it through this class, never the shared interface.
- **Writes:**
  - Comments and descriptions go from markdown to ADF (`markdownToAdf`, in `adf.ts`). The markdown can hold headings, lists, code, quotes, rules, tables, links, `[~accountid:…]` mentions and images. An image on the site's file host is written as a link to it.
  - `updateComment` edits ostra's own comment.
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
- **Rate limits:** a 429 is `rate-limited`, with the wait from `Retry-After`, or else from `X-RateLimit-Reset`. The per-credential budget reads `X-RateLimit-Remaining` and `X-RateLimit-Reset`, and waits without calling once nothing is left. API-token traffic is exempt from Jira's points quota; the burst and per-issue write limits (20 writes per 2 s) still apply.
- **No content in logs or errors:** log lines carry IDs, operation names, status codes and counts, never a token, an email or ticket text. Jira's error bodies can quote ticket text, so they're never read into a message.

`@ostra/adapter-jira/testing` exports the fake Jira, `createFakeJira()`: one in-process HTTP server that answers Jira's own paths and JSON shapes, the way the fake Linear does, for this package's tests and core's.

- **Sign-in and permissions:**
  - It serves the site, the gateway (`/ex/jira/{cloudId}/…`) and `/_edge/tenant_info`.
  - It has accounts with Basic `email:token` sign-in. A scoped token's scopes are checked per route, a scoped token answers only at the gateway and a classic one only at the site, and a missing scope is 401.
  - It keeps project permissions per account (`revokePermissions`).
- **Projects and workflows:** projects with Task, Bug, Epic and Sub-task types, seven statuses in Jira's three categories, and a workflow whose transitions are the only way to change a status. The workflow has a global "Won't do", Blocked, and no way back to Backlog.
- **Issues:** issues with ADF descriptions and comments, keys that change on a move (the old key still finds the issue), issue links, multipart attachments, remote links upserted by `globalId`, and issue properties.
- **Search:** JQL with `AND`, `OR`, `NOT`, `IN`, `IS EMPTY` and `ORDER BY`, paged by `nextPageToken`, with times read in the asking account's time zone. Unbounded or unknown JQL is a 400.
- **People:** user search by name or address, with addresses a person may hide.
- **Webhooks:** signed admin-webhook deliveries.
- **Rate limits:** a 429 on request, with or without `Retry-After`, and Jira's per-issue write limit.

`fakeJiraSuiteFixture` sets it up for `defineTrackerContractSuite`. The fake's assumptions are listed at the top of `fake-jira.ts`.

**Not proved here, and waiting for a real Jira Cloud site:**

- that a scoped token reaches attachment content and workflow reads through the gateway, and which exact granular scopes `workflowscheme/project` needs (S-12);
- that an upload's `media` node carries the file's name as `alt`, which is how the adapter finds its attachment;
- that a webhook retry keeps the first delivery's body and `timestamp`;
- that JQL reads absolute times in the asking account's time zone;
- whether `user/search` shows a service account people's addresses;
- that the classic `workflow/search` still answers with each transition's `from` and `to`;
- how a team-managed project, which has no workflow scheme, moves. The adapter falls back to finding transitions per ticket.
