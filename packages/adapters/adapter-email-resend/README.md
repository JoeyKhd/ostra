# @ostra/adapter-email-resend

The Resend email adapter (ADR 0007, ADR 0050, F-115). Apache-2.0. Resend is the first email option; SMTP (`@ostra/adapter-email-smtp`) is the second, and an install uses one of them.

- `ResendEmailAdapter` extends `NotificationAdapter` (`name: "resend"`, `channels: ["email"]`, `edits: false`), on the `resend` package.
- `send` mails one message per recipient with the rendered subject, HTML and text, and Resend's idempotency key made from the notification's key and the recipient.
- The API key comes in the constructor, from the secret store through core. The adapter never reads the environment and never logs the key or a mail's body.
