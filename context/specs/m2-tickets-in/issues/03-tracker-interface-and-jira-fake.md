# 03: Adapter SDK: the tracker interface, the Jira fake and the tracker suite

Status: done
Builder: adapters (contracts, first)
Blocked by: none
Features: F-005, F-007, F-010, F-031, F-064, F-097 (the interface); Q104 (the Jira fake)
Packages: `packages/adapter-sdk` (`src/tracker/`, `src/testing/`, `src/test-adapters/tiny-adapters.ts`), `packages/adapters/adapter-linear` (stubs only, so it compiles)
Spec: `../spec.md`, sections 5.2 and 8

## What to build

- **The new operations and types** of spec section 5.2 on `TrackerAdapter`: `listBoards`, `listStatuses` (with the four categories), `getTicketContext`, a stable `externalId` on `Ticket`, `moveTicket` through a mapping, `updateComment`, `linkTask`, `createTicket`, `detectCodeHostIntegration`, `verifyWebhook`, `parseWebhook` (a loose parse into a hint), and `listTickets`'s `order` and inclusive `updatedSince`. Each returns `AdapterResult` with the shared error codes, `rate-limited` among them.
- **The new capabilities:** `webhooks`, `commentEdit`, `attachments`, `transitions`. The common cases check that every one is declared.
- **The Jira fake:** a test-only `TrackerAdapter` over an in-memory Jira, exported from `@ostra/adapter-sdk/testing`: a status graph whose moves go through transitions, rich text as ADF that the fake converts to markdown, issue keys that change when an issue moves project, a signed webhook with `X-Hub-Signature` and `X-Atlassian-Webhook-Identifier`, and a per-issue write limit. It never ships as a product adapter.
- **The fake Linear server,** ported from spike 5's `fake-linear/` and widened to the plain API: issues, workflow states, teams, comments with threads, attachments, integrations, `viewer`, the OAuth endpoints with PKCE and rotating refresh tokens, signed deliveries with Linear's headers, and 429 with `Retry-After`.
- **`defineTrackerContractSuite`** grows to the full set of spec section 5.2: paging, `updatedSince`, a changed key found by its external ID, moves through the mapping (direct for Linear, by transition for Jira), an edited comment, a link made twice that exists once, webhook verification refusing a bad signature and a stale timestamp, own-echo detection, rate limits.
- The suite runs in this package against the Jira fake. Ticket 07 runs it against Linear. Until then the Linear adapter gets stubs that answer `unsupported`, so the repo compiles.

## Port from

`spikes/linear-agent-mode/src/fake-linear/` (the fake), `webhook-verify.ts` (the signature and the 60 s window).

## Done when

- [x] The suite passes against the Jira fake, and every case also checks that another organization's connection sees nothing.
- [x] The tiny adapters and the Linear adapter compile with the new members.
- [x] Committed as `✨ add the tracker interface and the Jira fake`.

## Comments
- 2026-11-19, core (contracts): done in `✨ add the tracker interface and the Jira fake`. For tickets 07, 08, 13, 14 and 15:
  - **The interface** (`src/tracker/base.ts`): `Ticket` gains `externalId` (branded `ExternalTicketId`), `status.category`, `parentExternalId` and `labels`. A `TicketRef` is `{ externalId }` or `{ key }`; `getTicket` takes either, or a bare key as before. New: `listBoards`, `listStatuses` (each `TrackerStatus` has `category`, `vendorType` and `position`, for the domain's mapping draft), `getTicketContext` (comments, attachments, images, parent, children, linked), `moveTicket` with a `StatusMapping` (`{ started, inReview, done }`, which the domain's mapping output fits) answering `{ moved, status }`, `updateComment`, `linkTask` (once per URL), `createTicket`, `detectCodeHostIntegration`, `verifyWebhook` (pure, with the request's secret and clock; answers the delivery ID, the signature's SHA-256 and the sender's time) and `parseWebhook` (a `TrackerWebhookHint`, with `byOwnUser`). `listTickets` takes `order: "updatedAt"` (oldest change first), an inclusive `updatedSince` and `pageSize`.
  - **One operation the spec didn't list:** `downloadFile(url, maxBytes)`, so core fetches ticket images with the connection's credential through the adapter, and the token never leaves it (spec section 11, item 9).
  - **Capabilities:** `webhooks`, `commentEdit`, `attachments`, `transitions`. The Linear adapter declares all four `false` until 07 and 08 build them, and answers `unsupported` from stubs; it already fills the new `Ticket` fields from Linear (`state.type` to the category, `labels`, the parent's ID) and asks `updatedAt: { gte }`.
  - **The suite** (`defineTrackerContractSuite`, `src/testing/tracker-suite.ts`) takes a `TrackerSuiteFixture` that drives the fake like a person would (seed, edit, move a ticket to another board, sign a delivery, answer 429), plus `other`, an adapter on another organization's workspace that every case checks sees nothing. `defineTrackerFirstCases` is the old first-cases suite, which the Linear adapter runs until 07 switches it to the full one.
  - **The Jira fake** (`src/testing/jira-fake.ts`, `createJiraSite`, `JiraFakeAdapter`, `createJiraFakeSuiteSubject`) passes the full suite. It also has `adfToMarkdown` and a `fail-after-write` fault.
  - **The fake Linear** (`src/testing/fake-linear/`, `createFakeLinear`) answers whatever selection set it's sent, by reading only the top-level fields and their arguments (`graphql-lite.ts`); it refuses fragments and directives so a misread fails loudly. It has teams with Linear's seven default states, issues, threaded comments (only the author edits one), attachments idempotent per URL, `integrations`, `webhookCreate`/`webhookDelete`, OAuth with PKCE and `actor=app` (the app user), rotating refresh tokens with the 30-minute retry of a rotated one, client credentials off by default (as on `ostra-test`), signed deliveries to the app's URL and to workspace webhooks on every change, and the faults `rate-limited`, `http500` and `fail-after-write`. `fakeLinearSuiteFixture` builds the suite's fixture on it for ticket 07.
  - **Unverified, and marked in the fake:** Linear's docs say only that `orderBy: updatedAt` gives "the most recently updated" first, so the fake answers newest first; `sort: [{ updatedAt: { order: Ascending } }]` answers oldest first, assumed from Linear's `IssueSortInput`. Ticket 07 should check both against `ostra-test` before it relies on either for polling.
  - Shared helpers in `src/plumbing/signature.ts`: `hmacSha256Hex`, `verifyHmacSha256Hex` (constant time), `sha256Hex`.
