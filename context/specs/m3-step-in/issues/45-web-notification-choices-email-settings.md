# 45: Web: notification choices and email settings

Status: ready-for-agent
Builder: web
Blocked by: 37, 41
Features: F-036, F-115
Packages: `apps/web` (`src/app/(panel)/account/notifications/`, `src/app/(panel)/organization/email/` (new), the member menu)
Spec: `../spec.md`, section 12 (`notification-settings`, `email-settings`)

## What to build

- **Notification choices** (`notification-settings`): each moment by panel (always on, shown checked and disabled), ticket and email, the member's address, and "Mail is off on this install" when it is.
- **Email settings** (`email-settings`), for the instance admin: off, Resend or SMTP with their fields, secrets entered once and shown as "set", the from address and name, "Send a test mail" with its result, and the locked state naming the settings that lock it. Organization admins who aren't the instance admin see the page read-only.
- Every string in the message files; phone width per F-075.

## Done when

- [ ] The screens match their targets, checked by eye, with the differences recorded here.
- [ ] Playwright: a member turns plans off for email and it saves; the instance admin sets Resend on the fake, sends a test mail and sees the result, switches to SMTP; a locked install shows read-only fields.
- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web`.
- [ ] Committed as `✨ add notification and email settings`.

## Comments
