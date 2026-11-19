# 04: Adapter SDK: notifications and tracker mentions

Status: done
Builder: adapters (contracts, first)
Blocked by: none
Features: F-036, F-115
Packages: `packages/adapter-sdk` (`src/notification/`, `src/tracker/`, `src/test-adapters/`, `src/testing/`)
Spec: `../spec.md`, section 5.2 ("`TrackerAdapter`", "`NotificationAdapter`"); ADR 0050

## What to build

- **`Notification`** grows by `kind`, `recipients`, `subject` and `rendered`, as section 5.2 lists. The `kind` union is exported, and its members match the needs-you reasons milestone 3 notifies, plus `test`.
- **`NotificationAdapter.send`** returns the provider's message ID. A new optional `update(notification, providerMessageId)`, and the capability `edits`. Capabilities keep `channels`.
- **`TrackerAdapter.findUsersByEmail(board, emails)`** and the capability `mentions`, implemented by the Jira fake (account IDs, `[~accountid:...]`) and the tiny adapter in the same commit. Linear's is ticket 10.
- **A fake email sink** in `src/testing/` for the email suites: a fake Resend API (the `POST /emails` shape, the `Idempotency-Key` header, a 429 with `Retry-After`) and a fake SMTP server on `node:net` (`EHLO`, `STARTTLS` accepted or refused, `AUTH PLAIN` and `LOGIN`, `MAIL`, `RCPT`, `DATA`, a 4xx and a 5xx on a recipient), each keeping what it received for assertions. No new dependency.
- **The notification contract suite** (new): one send per idempotency key; a refused recipient reported without failing the others; a rate limit as `rate-limited`; for email, HTML and text both carry the link and the subject; for an adapter with `edits`, `update` edits in place. It runs against a tiny notification adapter here, and against each real one in its ticket.
- **The tracker contract suite** gains `findUsersByEmail`: a match, no match, two emails at once.

## Done when

- [x] Tests: both suites pass against the tiny adapters and the Jira fake; the fakes' own tests cover their error modes.
- [x] Every caller compiles; `NotificationAdapter`'s existing members keep their shapes.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `adapter-sdk` and its dependents.
- [x] Committed as `✨ add notification contracts and mentions`.

## Comments
- 2026-11-19, adapters (contracts): done in `✨ add notification contracts and mentions`. **Notification:** `notificationKinds` (the needs-you reasons milestone 3 notifies and `test`, the same values as the database's `NotificationKind`); `Notification` gains `kind`, `recipients` (`{ memberId, email, trackerMention }`), `subject` and `rendered` (`{ subject, html, text }` or `null`), and, optional, `notificationId`, `taskId` and `ticket` (`TicketRef`), which the panel's rows and the tracker's comment need (ticket 11); `send` takes the same notification and answers `SendResult` (`providerMessageId` or `null`, and `refused: [{ memberId, reason }]`); `update(notification, providerMessageId)` defaults to `unsupported`; capabilities gain `edits`. **Tracker:** `findUsersByEmail(board, emails)` -> `[{ email, userId, mention }]` (default `unsupported`) and the capability `mentions`: the Jira fake (site `users` and `addUser`, mention `[~accountid:<id>]`, emails matched without case) and the tiny tracker (`users`, mention `@<userId>`) have it; Linear declares it false until ticket 10. **Fakes** (`src/testing/fake-email.ts`): `startFakeResendApi` (`POST /emails` with the bearer key, `Idempotency-Key` answering the first ID and 409 on another body, `rateLimitNext` for a 429 with `Retry-After`, `refuse` for a 422) and `startFakeSmtpServer` (`EHLO`, `STARTTLS` `offered`, `refused` or `none`, `requireTls`, `AUTH PLAIN` and `LOGIN`, `MAIL`, `RCPT` with named 4xx and 5xx replies, `DATA` dot-unstuffed, `commands` with AUTH payloads masked), each keeping what it received; its TLS certificate comes from `makeSelfSignedCert` (`src/testing/self-signed-cert.ts`), made at run time from `node:crypto` and a few lines of DER for `localhost` and `127.0.0.1`, so no private key is kept in the repo and no dependency is added. **Suites:** `src/testing/notification-suite.ts` (replacing the first cases of `first-case-suites.ts`, which is gone): once per key, a refused recipient reported without failing the others (skipped for a channel that reaches every member), a rate limit as `rate-limited` with its wait, an email's HTML and text both carrying the link and the subject, and `update` editing in place or `unsupported`; `sampleNotification` and `suiteRecipient` help the real adapters' fixtures. It runs against the tiny notifier on both channels (`panel` edits, `email` needs the rendered parts and an address). The tracker suite gains the mention case (a match, none, two at once, any case), run for the Jira fake in the full suite and for the tiny tracker by `defineTrackerMentionSuite`. The fakes' own tests (`src/testing/fake-email.test.ts`) cover their error modes, the certificate checked by Node's TLS with `ca` and `servername: localhost`. Break-it checks: thirteen (the key, the refused recipient, the text part, the edit, the rate limit, Jira's mention and case, Resend's key and idempotency, SMTP's dot-unstuffing, password and TLS rule, the certificate's name), each failing its case.
