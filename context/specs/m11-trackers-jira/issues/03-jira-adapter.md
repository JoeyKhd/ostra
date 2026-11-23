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

- [ ] Tests named for `F-008/c9`: the tracker contract suite passes for `adapter-jira` against the fake Jira, every case the in-memory fake passes included; its capabilities declare no agent sessions (break-it: declare `agentSessions: true`, and the parity row fails).
- [ ] Tests named for `F-008/c2`: every request goes to the gateway with the cloud ID, Basic auth carries the service account's email and token, and neither appears in an error, a log line or a thrown message.
- [ ] Tests named for `F-008/c3`: a delivery with a valid signature verifies; a wrong, missing or malformed one is refused; the delivery ID is the identifier header; a change by the service account is marked as an echo.
- [ ] Tests named for `F-008/c4`: `listTickets` pages through three pages by `nextPageToken`, oldest change first, inclusive of its time, with bounded JQL.
- [ ] Tests named for `F-008/c6`: ADF round trips for the subset (a heading, nested lists, a code block, a table, a mention, a link, a `media` node), and an unknown node becomes its text; ostra's comment is posted as ADF and edited in place; a remote link is upserted once per `globalId`; sub-tasks read as children.
- [ ] Tests named for `F-149/c6` and `F-149/c1` (Jira's parity): the files cases pass; a download off the attachment host gets no credential.
- [ ] `packages/adapters/adapter-jira` has its `LICENSE` (Apache-2.0), its `package.json` with no new dependency, and passes `pnpm check:licenses`.
- [ ] Checks for `adapter-jira` and `packages/adapter-sdk` pass, and the whole-repo checks (spec section 10).
- [ ] Committed as `✨ add the Jira tracker adapter` (several commits are fine, each one logical change).

## Comments

- 2026-11-23, lead: another agent started this ticket in parallel with the spec, on the maintainer's "start building immediately". The other tickets depend on it rather than repeat it. Ticket 02 adds `readWorkflow`, `via` and three capabilities; whichever of 02 and 03 lands second implements them for `adapter-jira` (02's `## Comments` says which). The connect kit and the real `readWorkflow` are ticket 04's.
