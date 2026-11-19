# @ostra/adapter-email-smtp

The SMTP email adapter (ADR 0007, ADR 0050, F-115), for installs with their own mail relay. Apache-2.0. The second email option after Resend (`@ostra/adapter-email-resend`).

- `SmtpEmailAdapter` extends `NotificationAdapter` (`name: "smtp"`, `channels: ["email"]`, `edits: false`), on `nodemailer`.
- The host, port, `secure` mode (`tls`, `starttls` or `none`), user, password and from address come in the constructor. `none` is refused unless the host is loopback, so a password never crosses a network in clear.
- `send` mails one message per recipient with the rendered subject, HTML and text, a `Message-ID` made from the notification's key and the recipient, and an `X-Ostra-Notification` header (a hash of the key) that groups one notification's messages. Each recipient is recorded as it is mailed, so a retry mails only who wasn't. The transport is pooled; `close()` closes it.
- The server's certificate is always checked. `tlsCa` adds a trusted certificate for a relay with a private CA; nothing turns the check off. `starttls` sends nothing, and never signs in, when the server won't upgrade.
- `smtpSettingsProblem(options)` says in words why settings can't be used; core calls it when an admin saves them.
- Errors: a 4xx reply is `unavailable` with a time to wait, a 5xx on `RCPT` is that recipient's refusal, and a failed sign-in or connection is the adapter's. The password, an address and a mail's words never reach an error or a log line.
- Proved against ticket 04's fake SMTP server (`startFakeSmtpServer`). The case through Resend's SMTP relay (`smtp.resend.com`, port 465, user `resend`) runs when `RESEND_API_KEY` and `EMAIL_FROM` are in the environment (`~/.config/ostra-dev/email.env`).
