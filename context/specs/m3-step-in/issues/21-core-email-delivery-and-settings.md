# 21: Core: email delivery and its settings

Status: ready-for-agent
Builder: core
Blocked by: 12, 13, 20
Features: F-115, F-036
Packages: `apps/core` (`src/notifications/email.ts`), `packages/domain` (`saveEmailSettings`)
Spec: `../spec.md`, sections 4 ("A notification") and 5.4 (settings); ADR 0050

## What to build

- **The email channel's adapter** from `EmailSettings`: `off` makes none (every email delivery is `skipped` with "mail is off"); `resend` builds ticket 12's adapter with the key from the secret store; `smtp` builds ticket 13's. The `OSTRA_EMAIL_*` settings, when set, override the row and set `lockedBySettings`, so the panel shows them read-only. A change of settings rebuilds the adapter on the next delivery, on every replica.
- **The delay:** an email delivery is due `OSTRA_EMAIL_DELAY_SECONDS` after the notification (the instance setting, else the setting's default), and at that time it's `skipped` when the member has read the notification in the panel or the item is no longer open.
- **The mail:** rendered by the domain's template for the kind (ticket 07), with the install's public address for the link and the mark, to the member's account address. A member with no address, or an unverified one while email is set up, is `skipped` with the reason (F-002's rule that mail goes only to a verified address applies from milestone 4's verification; until then the account's address is used, and the docs say so).
- **The test mail:** `saveEmailSettings` stores the settings (secrets into the secret store) and a "Send a test mail" action sends the `test` kind to the admin, recording `lastTestAt` and the result in words.
- **What never happens:** no mail body, subject or address in a log line; no ticket text, agent output, diff or check output in a mail.

## Done when

- [ ] Tests: with mail off, every email delivery is skipped and the rest are sent; with Resend on the fake, a due delivery sends once, a read one is skipped, a replayed job sends nothing; switching to SMTP on the fake sends the next one through SMTP; `OSTRA_EMAIL_PROVIDER` locks the row; the test mail records its result; a mail's HTML and text hold only the allowed fields.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `core` and `domain`.
- [ ] Committed as `✨ deliver notifications by email`.

## Comments
