# 03: Jira adapter: the client, ADF, intake, transitions, webhooks, files, sub-tasks, polling and the fake Jira

Status: in-progress
Builder: the Jira agent (started 2026-11-23 on the maintainer's "start building immediately", in the `jira-adapter` worktree)
Blocked by: none
Features: F-008, F-149 (Jira's parity), F-077 (sub-tasks)
Packages: `packages/adapters/adapter-jira` (new, Apache-2.0), `packages/adapter-sdk/src/testing/fake-jira/` (new, the HTTP fake), `packages/adapter-sdk/src/testing/tracker-suite.ts` (the subject for `adapter-jira`)
Spec: `../spec.md`, sections 5.3 (ticket 03's list), 6 and 11; ADR 0047, ADR 0013; `research/trackers.md` §2

## What to build

Everything in section 5.3's list for ticket 03, in short:

- **The REST v3 client:** hand-written on `fetch`, through `https://api.atlassian.com/ex/jira/{cloudId}` (or `OSTRA_JIRA_API_URL`), Basic `email:token`, a timeout per call, Zod schemas at each response that tolerate unknown fields, the per-credential rate budget with `Retry-After`, the burst and per-issue write limits; errors with the status code, never the body.
- **ADF to Markdown and Markdown to ADF,** hand-written (section 11: no dependency; switch to the three `mdast`/`micromark` packages only on the maintainer's yes to Q353), for the panel, the prompt and ostra's comments, round-trip tested.
- **JQL intake:** `listTickets` on `/search/jql`, bounded JQL ordered by `updated`, `nextPageToken`; `getTicket` by key or ID, a moved key followed by ID.
- **Transitions:** `moveTicket` by the transition (or route) that reaches the mapping's status, never `updateStatus`.
- **Webhooks:** `verifyWebhook` (`X-Hub-Signature` HMAC-SHA256, constant-time, `X-Atlassian-Webhook-Identifier`), `parseWebhook` (the six events, the service account's echoes marked).
- **Comments,** editing ostra's own in place; remote links for the task and the PR, once each; `createTicket`, `updateTicket`, `getUser`, `findUsersByEmail`.
- **Attachments and a ticket's files** (`ticketFiles: "all"`, F-149): attachments and ADF `media`, in order, once each; `downloadFile` to the attachment host only, no redirect, `maxBytes`; `byOstra`; `filesInText`.
- **Sub-tasks:** `subIssues: true`, parent and children.
- **Polling without a public address:** `listTickets` with `updatedSince`, nothing needing a webhook.
- **The declared capabilities** as section 5.3 lists; ticket 02's three (`magicWords: false`, `richText: "adf"`, `jqlFilter: true`) and `via` once 02 lands.
- **The fake Jira:** the HTTP fake in `testing/fake-jira/`, in the house style of `fake-linear/`: the routes the adapter calls, `_edge/tenant_info`, two sites, workflows and transitions (with a screen that refuses), ADF, attachments, signed deliveries on demand (and wrongly signed ones), the write limit, and a record of each request's site and credential digest.
- **The tracker contract suite** runs `adapter-jira` against the fake Jira as a subject, with every case the in-memory fake passes.

## Done when

- [x] Tests named for `F-008/c9`: the tracker contract suite passes for `adapter-jira` against the fake Jira, every case the in-memory fake passes included; its capabilities declare no agent sessions (break-it: declare `agentSessions: true`, and the parity row fails). *2026-11-23: the suite runs as `tracker contract: F-008/c9: jira, …` (all its cases but the two agent-session ones, which skip without `agentSessions`), and `F-008/c9: declares no agent sessions…` fails on `agentSessions: true`. The parity row is ticket 02's.*
- [x] Tests named for `F-008/c2`: every request goes to the gateway with the cloud ID, Basic auth carries the service account's email and token, and neither appears in an error, a log line or a thrown message.
- [x] Tests named for `F-008/c3`: a delivery with a valid signature verifies; a wrong, missing or malformed one is refused; the delivery ID is the identifier header; a change by the service account is marked as an echo. *2026-11-23: break-it done: with the HMAC check gone, `F-008/c3: verifies a signed delivery…` and the suite's signature case fail.*
- [x] Tests named for `F-008/c4`: `listTickets` pages through three pages by `nextPageToken`, oldest change first, inclusive of its time, with bounded JQL.
- [x] Tests named for `F-008/c6`: ADF round trips for the subset (a heading, nested lists, a code block, a table, a mention, a link, a `media` node), and an unknown node becomes its text; ostra's comment is posted as ADF and edited in place; a remote link is upserted once per `globalId`; sub-tasks read as children. *2026-11-23: a mention and a `media` node go one way each: markdown's `[~accountid:…]` becomes a mention node and a mention reads as `@Name`; a `media` node reads as its attachment's link, and ostra writes a file on the site as a link, since it can't name an upload's media ID.*
- [x] Tests named for `F-149/c6` and `F-149/c1` (Jira's parity): the files cases pass; a download off the attachment host gets no credential.
- [x] `packages/adapters/adapter-jira` has its `LICENSE` (Apache-2.0), its `package.json` with no new dependency, and passes `pnpm check:licenses`.
- [ ] Checks for `adapter-jira` and `packages/adapter-sdk` pass, and the whole-repo checks (spec section 10). *2026-11-23: typecheck, lint and tests of `adapter-jira` and `adapter-sdk`, `adapter-linear`'s typecheck, the root lint and `check:licenses` passed before each push; the rest of the repo is CI's (the lead's brief and `AGENT-RULES.md`), and this box is ticked when CI is green on the push.*
- [x] Committed as `✨ add the Jira tracker adapter` (several commits are fine, each one logical change). *2026-11-23: `b6f4da75` ✨ add the Jira tracker adapter, then ♻️ align the Jira adapter with the m11 spec.*

## Comments

- 2026-11-23, lead: another agent started this ticket in parallel with the spec, on the maintainer's "start building immediately". The other tickets depend on it rather than repeat it. Ticket 02 adds `readWorkflow`, `via` and three capabilities; whichever of 02 and 03 lands second implements them for `adapter-jira` (02's `## Comments` says which). The connect kit and the real `readWorkflow` are ticket 04's.
- 2026-11-23, the Jira agent: 03 landed first; 02 wasn't on `origin/main` at the last rebase, so **02 wires `adapter-jira`** to the three capabilities and `via`. What 02 and 04 find in `adapter-jira`:
  - **`readWorkflow(board)`** already answers the spec's `TrackerWorkflow` shape (`JiraBoardWorkflow`: `readable`, the board's statuses, the issue types' transitions in one, a global one as `any`), through the classic `workflowscheme/project` and `workflow/search?expand=transitions,statuses`. When 02 adds the base method, it needs `override` and 02's type; 04 moves it to `/workflows/search`.
  - **`findTransitionPath`, `distancesTo`, `planMapping`** in `transitions.ts` do what 02's `routeTo` and `reachability` will: a route of at most three transitions (`MAX_ROUTE_STEPS`, Q352), never through a done or cancelled status the move wasn't asked for. `#walk` can switch to 02's once it lands, and record each transition taken for `via`.
  - **`checkToken()`** reads back the account, the projects and the permissions each lacks, and whether workflows read: ticket 04's `jiraConnect.checkToken` can build its `ok | warn | fail` lines on it.
  - **The HTTP fake** is in `packages/adapter-sdk/src/testing/fake-jira/` (`createFakeJira`, `fakeJiraSuiteFixture`, exported from `@ostra/adapter-sdk/testing`). It has no Data Center host for 04's `findSite` yet.
  - **The window for a delivery** is 20 minutes (`JIRA_WEBHOOK_MAX_AGE_MS`), not Linear's 60 s: Jira's secondary deliveries take up to 15 minutes, and its retries come 5 to 15 minutes apart. The suite's fixture gained `webhookMaxAgeMs` for it. A replay inside the window repeats the signature, which the inbox claims once per connection.
  - **Not decided here:** `detectCodeHostIntegration` always answers not installed, since a service account's scopes can't see GitHub for Atlassian (Done is moved by ostra by default, choice 8). `searchTickets(board, jql)` (intake by JQL) is on `JiraAdapter` only: if core uses it, the shared interface needs an optional capability.
  - **What waits for a real site** is listed at the end of `packages/adapters/adapter-jira/README.md` (ticket 18's live run).
