# 07: Linear adapter: tickets, statuses, context and writes

Status: done
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

- [x] The tracker suite passes against the fake Linear server.
- [x] The live suite, gated on `linear.env`, passes against `ostra-test` team `OST`: it creates a ticket, reads its context with an image and a comment, moves it through the default mapping, comments and edits the comment, links a URL twice and finds one attachment, and archives the ticket. It prints no key.
- [x] Committed as `✨ add Linear's tickets, statuses and writes`.

## Comments
- 2026-11-19, adapters: done in `7ec5351` (`✨ add Linear's tickets, statuses and writes`). For tickets 14, 15, 27 to 29 and 39:
  - **Built:** every plain-API operation of ticket 03's interface on `LinearAdapter`, over `fetch`. The documents and their loose answer schemas are in `src/queries.ts`; `src/complexity.ts` scores each one by Linear's published rules, and `complexity.test.ts` keeps every document under 10,000 with its largest variables (a page of 250 tickets scores 7,376: labels are read 20 per issue for that reason). The live suite also reads Linear's own `X-Complexity` header on every answer.
  - **Checked against ostra-test (2026-11-19):** `orderBy: updatedAt` answers the newest first and `sort: [{ updatedAt: { order: Ascending } }]` the oldest first, and cursor pages of the ascending sort match one big page. So ticket 03's open point is settled: `listTickets({ order: "updatedAt" })` sends the ascending sort, and polling can rely on it. `attachmentCreate` is idempotent on the URL per issue and updates the subtitle. `uploads.linear.app` answers the file directly (no redirect) with the token, and 401 without it.
  - **Every operation checks the board:** an issue whose team isn't `board.externalId` is `not-found`, so a ticket that moved team is read with its new board (ticket 14 updates the cache row's board from a webhook's team, or the poller of the new board finds it). `updateComment` also refuses a comment that's on another ticket.
  - **`downloadFile`** sends the token only to the origins in `fileOrigins` (default `https://uploads.linear.app`), follows no redirect, and stops reading past `maxBytes`. `getTicketContext`'s `images` lists only files on those origins: an inline image on another host isn't fetched, so it isn't listed. Image attachments are told by their URL's extension.
  - **Linear's `duplicate` state type** (OST has one) is in the `cancelled` category. `listStatuses` orders by type, then Linear's position, and numbers `position` from 0. OST has no "In Review" state, so its draft mapping's in-review is "In Progress": the move to in-review writes nothing there.
  - **One additive contract change, its own commit** (`6f8c4f4`, `✨ add an optional link kind to linkPullRequest`): `linkPullRequest(board, key, url, options?: { kind?: "closes" | "references" })`, so the board's magic word reaches Linear's `linkKind` (`closes` or `links`). Without it, Linear's default, as milestone 1 sent.
  - **Rate limits:** the budget is keyed `linear:<16 hex of the token's SHA-256>`, fed from `X-RateLimit-Requests-*` (Linear's reset is in ms; the budget stores it). A 429 is `rate-limited` with `Retry-After`, or the reset when there's none. Nothing retries inside the adapter: a write Linear applied and then answered 500 is `unavailable`, and ticket 15's writer looks for its marker before retrying.
  - **Capabilities now:** `commentEdit: true`, `attachments: true`; `webhooks` stays `false` until ticket 08.
  - **Tests:** the full tracker suite passes against the fake Linear twice, with an app token and with a personal API key. The live suite (`linear-adapter.live.test.ts`, gated on `linear.env`) creates a ticket with an uploaded image and a person's comment, reads its context and downloads the image, pages the ascending sort, moves it through the default mapping, comments and edits the comment, links a URL twice and finds one attachment, and archives the ticket. It passed on 2026-11-19.
