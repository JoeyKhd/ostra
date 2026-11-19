# 03: Adapter SDK: the tracker interface, the Jira fake and the tracker suite

Status: ready-for-agent
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

- [ ] The suite passes against the Jira fake, and every case also checks that another organization's connection sees nothing.
- [ ] The tiny adapters and the Linear adapter compile with the new members.
- [ ] Committed as `✨ add the tracker interface and the Jira fake`.

## Comments
