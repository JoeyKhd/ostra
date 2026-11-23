# 02: Adapter SDK: the callback URL, webhook registration, and a board's settings

Status: ready-for-agent
Builder: adapters
Blocked by: none
Features: F-153 (and F-152's parity rows)
Packages: `packages/adapter-sdk` (`tracker/base.ts`, `tracker/capabilities.ts`, `testing/tracker-suite.ts`, `testing/tracker-workflow-cases.ts`), `apps/docs/content/contributing/adapters.mdx` (the guide's sample), and the subjects in the same commit: `packages/adapters/adapter-linear`, `packages/adapter-sdk/src/testing/jira-fake.ts`, `packages/adapter-sdk/src/test-adapters/tiny-adapters.ts`
Spec: `../spec.md`, section 5.2; ADR 0072

## What to build

- **`TrackerWebhookRequest.callbackUrl?: string`:** the callback URL exactly as registered, never logged. Its doc says which tracker needs it (Trello signs body + URL) and that the inbox passes it for every delivery.
- **`TrackerCapabilities.webhookRegistration: boolean`;** Linear `false`, Jira `false`, the tiny tracker `false`, `adapter-trello` `true` (ticket 03).
- **`ensureBoardWebhook(board, callbackUrl)` and `removeBoardWebhook(board, callbackUrl)`** on `TrackerAdapter`, both `unsupported` without the capability, with the doc of section 5.2. The returned `{ webhookId, created }` is idempotent; removal of a missing one is `not-found`.
- **`BoardRef.keyPrefix?: string` and `BoardRef.statusCategories?: Readonly<Record<string, TicketStatusCategory>>`,** with the docs of section 5.2. Every adapter ignores what it doesn't use; `adapter-trello` applies both (ticket 03).
- **The contract suite:**
  - the webhook case signs with the fixture's callback URL;
  - a registration case that runs only where `webhookRegistration` is declared: create once, a second call returns the same ID, the removal makes the next delivery be refused, and a subject without the capability answers `unsupported` from both;
  - a board-settings case: a `BoardRef` with `keyPrefix` and `statusCategories` reports `TR-12` and the admin's categories; one without them reports the tracker's own things.
- **The capability checks and the guide:** `trackerCapabilityTypes` gains `webhookRegistration: "boolean"`; the adapter guide's `tracker-capabilities.ts` sample gains `webhookRegistration: false` and names the two methods (`apps/docs/content/contributing/adapters.mdx`), and `adapter-guide-samples.test.ts` compiles it. `tracker-parity.ts`'s table stays as it is.
- **The `downloadFile` doc amendment lands with ticket 03,** which is the first adapter to need it: "no redirect is followed" becomes "at most one hop to the tracker's own storage, without the credential" (ADR 0072, section 5). If 02 lands second, 02 writes it; either way it's in the same commit as the method it documents.

## Done when

- [ ] Tests named for `F-153/c3`: a fixture-signed delivery verifies with its callback URL; a different URL or a re-serialized body is `bad-signature`; a subject without `webhookRegistration` answers `unsupported` (break-it: return `ok` from the base method, and the case fails).
- [ ] Tests named for `F-153/c5`: a board's `keyPrefix` and `statusCategories` change the reported key and category, and an adapter that declares neither is unaffected.
- [ ] Tests named for `F-153/c9`: `trackerCapabilityTypes` checks `webhookRegistration` on every subject, the guide's sample compiles, and the suite passes for Linear, the in-memory Jira fake and the tiny tracker (and, once 03 lands, `adapter-trello`).
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` for `adapter-sdk`, `adapter-linear` and `adapter-jira` pass; `pnpm check:licenses` passes; the whole-repo checks run before the push.
- [ ] Committed as `✨ let an adapter register its own webhooks`.
