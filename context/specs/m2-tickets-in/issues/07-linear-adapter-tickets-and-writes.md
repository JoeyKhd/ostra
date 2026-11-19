# 07: Linear adapter: tickets, statuses, context and writes

Status: ready-for-agent
Builder: adapters
Blocked by: 03
Features: F-005, F-007, F-010, F-031, F-064, F-097
Packages: `packages/adapters/adapter-linear`
Spec: `../spec.md`, sections 5.2 and 11 (items 4, 5 and 9)

## What to build

The plain-API operations of ticket 03's interface, on milestone 1's adapter, over GraphQL with `fetch` (no `@linear/sdk`: spec section 10).

- **Reads:** `listBoards` (teams), `listStatuses` (workflow states, Linear's types mapped to the four categories), `listTickets` ordered by `updatedAt` with an inclusive `updatedSince` and pages of up to 250, `getTicket` by the stable ID or the key, `getTicketContext` (description, comments with their threads, labels, attachments, inline image URLs from the markdown, parent, relations: blocks, related, duplicate), and `detectCodeHostIntegration` (the workspace's GitHub integration, read from `integrations`).
- **Writes:** `moveTicket` (sets the state the mapping names; no transition graph), `comment` and `updateComment`, `linkPullRequest` (milestone 1's `attachmentLinkGitHubPR`, with `linkKind`), `linkTask` (`attachmentCreate`, idempotent by URL per issue), `createTicket`.
- **Every query** keeps its complexity under Linear's 10,000 per query, says so in a test, and asks only for the fields it reads. Responses are parsed loosely. The rate budget reads `X-RateLimit-*` and `Retry-After`, and a 429 becomes `rate-limited` with the wait.
- **Keys change:** everything is keyed on the issue's UUID; the key is only what it was at the last read.
- **Image fetches** are a separate method, `fetchFile(url)`, that the server calls with the connection's token, only for `uploads.linear.app` URLs or the issue's own attachments, with the size cap of spec section 11, item 9.
- Ticket text is returned as data. Nothing here builds a shell command, and no log line holds a title, a description or a comment.
- The tracker contract suite (ticket 03) runs against the adapter on the fake Linear server.

## Done when

- [ ] The tracker suite passes against the fake Linear server.
- [ ] The live suite, gated on `linear.env`, passes against `ostra-test` team `OST`: it creates a ticket, reads its context with an image and a comment, moves it through the default mapping, comments and edits the comment, links a URL twice and finds one attachment, and archives the ticket. It prints no key.
- [ ] Committed as `✨ add Linear's tickets, statuses and writes`.

## Comments
