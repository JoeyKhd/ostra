# 13: The SMTP email adapter

Status: done
Builder: adapters
Blocked by: 04
Features: F-115
Packages: `packages/adapters/adapter-email-smtp` (new), `pnpm-lock.yaml`
Spec: `../spec.md`, sections 5.2 and 10; ADR 0050, ADR 0007

## What to build

SMTP is the second option, for installs with their own mail relay or no internet (ADR 0007). Build it after ticket 12 if both are in reach at once.

- An Apache-2.0 package with one class, `SmtpEmailAdapter extends NotificationAdapter` (`name: "smtp"`, `channels: ["email"]`, `edits: false`), on `nodemailer` (MIT-0, confirmed 2026-11-19), pinned exactly, with its types if they come separately (the same yes covers them).
- **Settings in the constructor:** host, port, `secure` (`tls`, `starttls`, `none`), user, password (from the secret store, through core), the from address and name. `none` is refused unless the host is loopback, so a password never crosses a network in clear.
- **`send`**: one message per recipient, with a `Message-ID` derived from the notification's key and the recipient, so a retry can be recognized; the transport is pooled and closed on `close()`.
- **`health`**: `verify()` on the transport, with the reason in words (refused, auth failed, TLS failed), never the password.
- **Errors:** a 4xx reply is retryable; a 5xx on `RCPT` is that recipient's failure; a connection or auth failure is the adapter's.
- The notification contract suite passes on the fake SMTP server (ticket 04); the live case, gated on `email.env`, sends through Resend's SMTP relay (`smtp.resend.com`, port 465, user `resend`, the API key as password) to Resend's test recipient.

## Done when

- [x] Tests: the suite passes on the fake SMTP server, with `STARTTLS` accepted and refused.
- [x] `pnpm-lock.yaml` updated in the same commit; `pnpm check:licenses` passes.
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for the package.
- [x] Committed as `✨ add the SMTP email adapter`.

## Decided 2026-11-19

Decided on the maintainer's delegation while preparing the build, from the open points of the milestone 3 targets (`context/brand/app-targets/m3/`) and the spec's gaps. If the maintainer disagrees with one, it goes back to `context/open-questions.md` and this section changes.

- **SMTP's live proof is in-process, with no new dependency** (Q186). The real adapter on nodemailer sends over loopback to ticket 04's SMTP server on `node:net`, run in the test, with `STARTTLS` accepted (on a throwaway self-signed certificate the test makes with `openssl`, which Git for Windows and CI's Ubuntu both have) and refused, and `AUTH PLAIN`. That proves the adapter's whole send path with no network. A third-party SMTP server package (`smtp-server`, for example) would be a new dependency, so it waits for the maintainer's yes (ticket 51, step 11). The case through Resend's SMTP relay stays gated on `email.env`, and waits for the key (ticket 51, step 1).

## Comments
- 2026-11-19, adapters: done in `✨ add the SMTP email adapter` (c0da3af). `SmtpEmailAdapter` on `nodemailer` 10.3.1 (pinned; it ships its own types, so no `@types` package), pooled, one message per recipient, `Message-ID` from the key and the recipient, each recipient recorded as mailed so a retry sends only the rest. `secure` is `tls`, `starttls` (never sends, never signs in, when the server will not upgrade) or `none` (loopback only, refused by `smtpSettingsProblem`, which core can call when an admin saves the settings); the certificate is always checked, `tlsCa` adds a private CA. A 4xx is `unavailable` with a wait, a 5xx on RCPT is that recipient's refusal, a failed sign-in is `unauthorized`. Proved live and in process against the fake SMTP server (STARTTLS accepted and refused, SMTPS, AUTH, an untrusted certificate); the fake gained `implicitTls`. Only the case through Resend's SMTP relay waits for the key (ticket 51, step 1). The rate-limit case of the suite is skipped: SMTP has no rate-limit signal of its own. Break-it checks: eleven, each failing its test.
- 2026-11-19, review: the live case is not a box of this ticket any more. It moved to ticket 51, step 1 (a maintainer step: it needs the Resend key, Q186), which names it. This ticket is `done` because every box it keeps holds; F-115 stays `building` until step 1 is done.
