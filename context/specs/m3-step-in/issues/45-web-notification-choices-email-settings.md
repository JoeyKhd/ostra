# 45: Web: notification choices and email settings

Status: resolved
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

- [x] The screens match their targets, checked by eye, with the differences recorded here. (2026-11-20, the wired pages at 1440 wide from the Playwright run's frames, against `notification-settings` and `email-settings`; the parts were checked on 2026-11-19. Differences in the Comments.)
- [x] Playwright: a member turns plans off for email and it saves; the instance admin sets Resend on the fake, sends a test mail and sees the result, switches to SMTP; a locked install shows read-only fields. (`apps/web/e2e/21-notification-email.spec.ts` and `06-email-locked.spec.ts`; break-its in `context/proof/F-115.md`.)
- [x] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass for `web` (and for `domain` and `core`, which this close touched).
- [x] Committed as `✨ add notification and email settings`. (The work landed as `24ff1bf` (`✨ add the notification and email settings' parts`) and `3af06b0` (`✨ wire milestone 3's screens to the API`); its proof is `✅ prove the email and notification pages`.)

## Comments

- 2026-11-19: the parts are in, `24ff1bf` (`✨ add the notification and email settings' parts`); the mail's two lockups (`logo-abyss@2x.png`, `logo-shell@2x.png`, B-015) now ship in `apps/web/public/email/`, `8730f22`, with an F-115 test. Checked by eye against `notification-settings`, `email-settings` and `email-needs-you` (the domain's renderer, light and dark): they match; the email panel's `On, through Resend` wraps at 300px. **Not done yet:** the routes `/account/notifications` and `/organization/email`, the member menu's entry and the Playwright run wait on ticket 37's API, not on `main` yet.
- 2026-11-19, integrate (ticket 50): `/account/notifications` and `/organization/email` are wired to `notifications.preferences.*`, `email.settings.*` and `email.sendTest` (`3af06b0`), and used live in milestone 3's demo (`../demo.md`). Not done: this ticket's Playwright cases, the by-eye check against the targets, and the differences `demo.md` lists.
- 2026-11-20, close: every box holds, `Status: resolved`. Commits: `24ff1bf` and `3af06b0` (the screens), and `✅ prove the email and notification pages` (this ticket's Playwright cases, a gap and the proof rows). **The gap:** the panel's Resend adapter always called Resend's own API, so no stack could set Resend up on a fake. A new setting, `OSTRA_RESEND_API_URL` (Resend's own by default; `docs/configuration.md`), which the panel and core read, as `OSTRA_LINEAR_API_URL` does for Linear; the e2e stack runs the fake Resend API beside its fakes (`fakes.ts`, the stack file, `.fakes.env`, `compose.e2e.yaml`), and core's email tests now send through core's own factory at the fake's address. The cases: the instance admin picks Resend, types the fake's key and the sender, saves, sends the test mail and reads "Accepted by Resend … Check demo@demo.com for it.", then switches to SMTP and reads it back after a reload (and turns mail off again for the specs after it); a member unticks "Email for Plans", sees "Saved." and finds it unticked after a reload, the ticket's box and the other moments unchanged; on the second e2e stack, whose settings set SMTP (`e2eLockedEmail`, `OSTRA_E2E_EMAIL_LOCKED=1`), the page names the settings that lock it, shows their values in disabled fields and offers no save. One break-it pass: the panel's Resend without the setting, the boxes saved as they were, the locked form enabled; each failed its case. Nothing here needs what this machine lacks: the live Resend send stays Q186's (F-115's notes).
- 2026-11-20, differences from the targets, by eye: both pages lacked the targets' lede (the email page's was in the messages, unused): fixed in this close. The notification choices save each box as it changes, so there's no "Save choices" button, and "Saved." shows under the table (`3af06b0`). The email page's save is a "Save" button under the form, not "Save settings" in the header; "On, through Resend" wraps in the 300px panel (2026-11-19); after Resend is first set, "Last change" reads "Sender changed by …" rather than "Set to Resend by …"; a locked install with no SMTP password shows an empty disabled field marked "Not set".
