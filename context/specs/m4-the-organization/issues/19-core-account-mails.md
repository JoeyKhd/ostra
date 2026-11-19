# 19: Core: account mails

Status: resolved
Builder: core
Blocked by: 04, 06
Features: F-002, F-115
Packages: `apps/core` (`src/reactions/account-mail.ts`), `packages/domain` (the templates of ticket 06)
Spec: `../spec.md`, section 4 ("An invitation", "A reset"); ADR 0053, ADR 0050

## What to build

- **`account-mail.send`,** keyed by purpose and record ID: an invitation, a membership's verification, or a reset. It reads the record, checks it's still pending (an invitation revoked, a membership already verified or a reset link used sends nothing), renders the mail with ticket 06's template, and sends it through the install's email channel (milestone 3's Resend or SMTP adapter) as the `account` category: at once, with no member choices.
- **The link** is built from the install's public address and the record's ID or token, held in memory for the send, and never written to a log line, an error, a job's payload (the payload is the record's ID) or the delivery row.
- **With email off,** nothing is enqueued, and the panel's copy-link path is the only one (ticket 22).
- **Failures** retry with milestone 3's backoff and show on the invitation's row as "Mail failed: <provider's words>" for the admin.

## Done when

- [x] Tests named `it("F-002: ...")` and `it("F-115: ...")` against the fake Resend and the fake SMTP server: each purpose sends one mail with its link in both parts; a replayed job sends nothing twice; a revoked invitation sends nothing; no log line, payload or delivery row holds the link (searched by value).
- [x] Committed as `✨ add the account mails`.

## Comments

- 2026-11-19: built in `apps/core/src/reactions/account-mail.ts`, wired in `core.ts` beside `notify.deliver`, sending through the email channel's new `accountSender` (the same Resend or SMTP adapter the moments use, no delay, no member choices). A new `AccountMailDelivery` row (migration `20261121200000_account_mail_delivery`, additive) keeps each purpose and record once, its attempts and the provider's words of a failure, which ticket 22 shows on the invitation's row as "Mail failed: ...". A verification and a reset each mint a fresh token at the send, kept only as its SHA-256 (`packages/domain/src/mail/account-mail-links.ts`); the reset's token is better-auth's own `reset-password:` row. Log lines name the delivery row, never the record: an invitation's ID is its link. Enqueueing (and enqueueing nothing with email off) is ticket 22's. Break-its: the revoked check dropped, and the replay guard loosened, each failed its test. Commit: see the next line.
