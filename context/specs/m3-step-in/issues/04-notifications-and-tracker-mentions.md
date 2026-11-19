# 04: Adapter SDK: notifications and tracker mentions

Status: ready-for-agent
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

- [ ] Tests: both suites pass against the tiny adapters and the Jira fake; the fakes' own tests cover their error modes.
- [ ] Every caller compiles; `NotificationAdapter`'s existing members keep their shapes.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `adapter-sdk` and its dependents.
- [ ] Committed as `✨ add notification contracts and mentions`.

## Comments
